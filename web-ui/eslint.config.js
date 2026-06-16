import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["static/**", "node_modules/**", "bin/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
