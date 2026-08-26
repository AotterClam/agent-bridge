import { expect, test } from "bun:test";
import {
  antigravityImageToolFromText,
  imageCapabilitiesFromAntigravityProbe
} from "../src/antigravity.js";
import { imageCapabilitiesFromCodexProbe } from "../src/codex.js";
import { imageCapabilitiesFromGrokCatalog } from "../src/grok.js";
import {
  allowsImageRunner,
  cachedCapabilities,
  liteLLMModelInfo
} from "../src/index.js";

const fingerprint = { executable: "/opt/bin/agent", version: "agent 9.9.9" };

test("maps host self-report and tool catalog evidence without version guessing", () => {
  const codex = imageCapabilitiesFromCodexProbe(true, fingerprint);
  expect(codex.generation.status).toBe("supported");
  expect(codex.edit.status).toBe("supported");
  expect(codex.fingerprint).toEqual(fingerprint);
  expect(codex.generation.supported_openai_params).not.toContain("size");
  expect(codex.generation.provider_capabilities).toMatchObject({
    self_report: { imageGeneration: true },
    imagegen_tool: { backend_defaults: { size: "auto" } }
  });
  expect(imageCapabilitiesFromCodexProbe(undefined, fingerprint).generation.status)
    .toBe("unknown");

  const grok = imageCapabilitiesFromGrokCatalog(
    ["read_file", "image_gen", "image_edit"],
    fingerprint
  );
  expect(grok.generation.status).toBe("supported");
  expect(grok.edit.status).toBe("supported");
  expect(grok.generation.supported_openai_params).toContain("size");
  expect(grok.edit.supported_openai_params).not.toContain("size");
  expect(grok.generation.provider_capabilities).toMatchObject({
    tool: "image_gen",
    parameters: { aspect_ratio: { default: "auto" } }
  });
  expect(imageCapabilitiesFromGrokCatalog(null, fingerprint).generation.status)
    .toBe("unknown");

  const agyTool = antigravityImageToolFromText([
    "generate_image",
    "What the image should depict, or how to edit the given images.",
    "Images to edit, combine, or use as references.",
    "Short descriptive name for the saved file.",
    "Optional aspect ratio for the generated image. Supported values:"
  ].join("\n"));
  const agy = imageCapabilitiesFromAntigravityProbe(agyTool, null, fingerprint);
  expect(agy.generation.status).toBe("unsupported");
  expect(agy.generation.supported_openai_params).toEqual([]);
  expect(agy.generation.provider_capabilities).toMatchObject({
    tool: "generate_image",
    parameters: {
      image_paths: { max_items: 3, uses: ["edit", "combine", "reference"] },
      aspect_ratio: {
        enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"],
        default: "1:1"
      }
    },
    execution_authority: { single_tool: null }
  });
  expect(imageCapabilitiesFromAntigravityProbe(null, null, fingerprint).generation.status)
    .toBe("unknown");
});

test("exposes LiteLLM model-info names while retaining bridge-native evidence", () => {
  const images = imageCapabilitiesFromGrokCatalog(["image_gen", "image_edit"], fingerprint);
  const [info] = liteLLMModelInfo({
    id: "grok",
    name: "Grok Build",
    available: true,
    version: fingerprint.version,
    error: null,
    images,
    models: [{
      id: "grok-test",
      name: "Grok Test",
      reasoningEfforts: ["high"]
    }]
  });
  expect(info).toMatchObject({
    model_name: "grok-test",
    litellm_params: { model: "grok-test" },
    model_info: {
      supported_openai_params: ["stream", "tools", "tool_choice", "reasoning_effort"],
      agent_bridge: {
        adapter_id: "grok",
        images: { generation: { supported_openai_params: expect.arrayContaining(["size"]) } }
      }
    }
  });
});

test("caches discovery until refresh and fails closed except for Grok live smoke", async () => {
  let loads = 0;
  const capabilities = cachedCapabilities(async () => {
    loads++;
    return [];
  });
  const first = capabilities();
  expect(capabilities()).toBe(first);
  await first;
  expect(loads).toBe(1);
  expect(capabilities(true)).not.toBe(first);
  expect(loads).toBe(2);

  expect(allowsImageRunner("codex", "unknown")).toBe(false);
  expect(allowsImageRunner("antigravity", "unknown")).toBe(false);
  expect(allowsImageRunner("grok", "unknown")).toBe(true);
  expect(allowsImageRunner("grok", "unsupported")).toBe(false);
});
