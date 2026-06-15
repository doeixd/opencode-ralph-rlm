import { defineHandler } from "nitro/h3";
import type { OpenAIModelsResponse } from "../../lib/openai-compat.js";

export default defineHandler((): OpenAIModelsResponse => {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: [
      {
        id: "supervisor",
        object: "model",
        created: now,
        owned_by: "ralph-rlm",
      },
    ],
  };
});