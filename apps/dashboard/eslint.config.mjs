// @ts-check
import withNuxt from "./.nuxt/eslint.config.mjs";

export default withNuxt().append({
  ignores: [".nuxt/**", ".output/**", "dist/**", "eslint.config.mjs"],
});
