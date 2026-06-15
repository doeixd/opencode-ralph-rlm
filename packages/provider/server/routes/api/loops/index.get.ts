import { defineHandler } from "nitro/h3";
import { loopRegistry } from "../../../lib/loop-registry.js";

/** OpenAPI: GET /api/loops — list active loop runs */
export default defineHandler(async () => {
  const loops = await loopRegistry.listAsync();
  return { loops };
});