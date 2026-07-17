import { MODULE_ID } from "./constants.mjs";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | initialising`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready`);
});
