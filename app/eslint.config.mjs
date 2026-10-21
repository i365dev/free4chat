import nextVitals from "eslint-config-next/core-web-vitals"
import prettierConfig from "eslint-config-prettier"
import prettier from "eslint-plugin-prettier"
import unusedImports from "eslint-plugin-unused-imports"

// Next 16 enables React Compiler diagnostics even when compilation is off.
// Preserve the previous runtime Hooks checks without adopting compiler policy.
const compilerRules = Object.fromEntries(
  nextVitals.flatMap(({ rules = {} }) =>
    Object.keys(rules)
      .filter(
        (rule) =>
          rule.startsWith("react-hooks/") &&
          rule !== "react-hooks/rules-of-hooks" &&
          rule !== "react-hooks/exhaustive-deps"
      )
      .map((rule) => [rule, "off"])
  )
)

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/out/**",
      "**/.next/**",
      "**/.open-next/**",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  ...nextVitals,
  prettierConfig,
  {
    plugins: { "unused-imports": unusedImports, prettier },
    rules: {
      ...compilerRules,
      "no-unused-vars": "off",
      "react/require-default-props": 0,
      "unused-imports/no-unused-imports": "error",
      "prettier/prettier": "error",
      "@typescript-eslint/explicit-module-boundary-types": 0,
      "react/jsx-filename-extension": [
        1,
        {
          extensions: [".ts", ".tsx"],
        },
      ],
      "react/jsx-props-no-spreading": 0,
      "jsx-a11y/anchor-is-valid": 0,
      "react/react-in-jsx-scope": 0,
      "react/display-name": 0,
      "react/prop-types": 0,
      "@typescript-eslint/explicit-function-return-type": 0,
      "@typescript-eslint/explicit-member-accessibility": 0,
      "@typescript-eslint/indent": 0,
      "@typescript-eslint/member-delimiter-style": 0,
      "@typescript-eslint/no-explicit-any": 0,
      "@typescript-eslint/no-var-requires": 0,
      "no-use-before-define": 0,
      "@typescript-eslint/no-use-before-define": 0,
      "import/extensions": [
        "error",
        "never",
        {
          svg: "always",
        },
      ],
      "react/no-unescaped-entities": 0,
      "jsx-a11y/label-has-associated-control": 0,
      "react/no-unused-prop-types": 0,
      "no-underscore-dangle": 0,
      "@typescript-eslint/no-unused-vars": [
        0,
        {
          argsIgnorePattern: "^_",
        },
      ],
      "no-console": [
        2,
        {
          allow: ["warn", "error"],
        },
      ],
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal"],
          pathGroups: [
            {
              pattern: "react",
              group: "external",
              position: "before",
            },
          ],
          pathGroupsExcludedImportTypes: ["react"],
          "newlines-between": "always",
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],
    },
  },
]
