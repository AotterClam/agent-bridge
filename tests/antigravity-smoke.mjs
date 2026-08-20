import { startAgentBridge } from "../src/index.js";

async function main() {
  console.log("Starting agent bridge with Antigravity adapter...");
  const bridge = await startAgentBridge();
  console.log(`Bridge listening on ${bridge.baseUrl}`);

  try {
    console.log("Fetching capabilities via GET /capabilities...");
    const adapters = await bridge.adapters();
    console.log("Adapters discovered:", adapters.map((a) => ({
      id: a.id,
      name: a.name,
      available: a.available,
      version: a.version,
      modelsCount: a.models.length
    })));

    const agyAdapter = adapters.find((a) => a.id === "antigravity");
    if (!agyAdapter) {
      throw new Error("Antigravity adapter not found in /capabilities");
    }
    if (!agyAdapter.available) {
      throw new Error(`Antigravity unavailable: ${agyAdapter.error}`);
    }

    console.log("Antigravity models available:", agyAdapter.models);

    const { adapter, baseUrl, apiKey } = await bridge.connection("antigravity");
    console.log(`Connected to Antigravity at ${baseUrl} with token: ${apiKey.slice(0, 10)}...`);

    // 1. GET /v1/models
    console.log("Testing GET /v1/models...");
    const modelsRes = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    if (!modelsRes.ok) {
      throw new Error(`GET /v1/models failed: ${modelsRes.status}`);
    }
    const modelsData = await modelsRes.json();
    console.log(`GET /v1/models returned ${modelsData.data.length} models.`);

    // 2. POST /v1/chat/completions (non-stream)
    const testModel = adapter.models[0]?.id ?? "gemini-3.7-flash";
    console.log(`Testing POST /v1/chat/completions (non-stream) with model: ${testModel}...`);
    const chatRes = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: "user", content: "Reply with exactly: 'antigravity-smoke-ok'" }]
      })
    });

    if (!chatRes.ok) {
      const err = await chatRes.text();
      throw new Error(`Chat completion failed (${chatRes.status}): ${err}`);
    }
    const chatData = await chatRes.json();
    console.log("Response:", chatData.choices[0]?.message?.content?.trim());
    console.log("Usage:", chatData.usage);

    // 3. POST /v1/chat/completions (stream)
    console.log("Testing POST /v1/chat/completions (streaming)...");
    const streamRes = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: testModel,
        stream: true,
        messages: [{ role: "user", content: "Count 1 to 3 in words." }]
      })
    });

    if (!streamRes.ok) {
      throw new Error(`Streaming failed: ${streamRes.status}`);
    }

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let streamText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta?.content;
            if (delta) {
              streamText += delta;
              process.stdout.write(delta);
            }
          } catch {}
        }
      }
    }
    // 4. POST /v1/chat/completions with tools
    console.log("Testing POST /v1/chat/completions with function tools...");
    const toolChatRes = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: testModel,
        messages: [{ role: "user", content: "Check the weather in Taipei in celsius." }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather for a city",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                  unit: { type: "string", enum: ["celsius", "fahrenheit"] }
                },
                required: ["location"]
              }
            }
          }
        ]
      })
    });

    if (!toolChatRes.ok) {
      throw new Error(`Tool chat failed: ${toolChatRes.status}`);
    }
    const toolChatData = await toolChatRes.json();
    console.log("Tool call finish_reason:", toolChatData.choices[0]?.finish_reason);
    console.log("Tool calls:", toolChatData.choices[0]?.message?.tool_calls);

    console.log("\n✅ Antigravity live smoke test passed successfully!");
  } finally {
    await bridge.close();
    console.log("Bridge server closed.");
  }
}

main().catch((err) => {
  console.error("❌ Smoke test failed:", err);
  process.exit(1);
});
