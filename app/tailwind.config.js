const defaultTheme = require("tailwindcss/defaultTheme")

module.exports = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", ...defaultTheme.fontFamily.sans],
      },
      keyframes: {
        "float-up": {
          "0%": { opacity: "1", transform: "translateY(0) scale(1)" },
          "80%": { opacity: "0.8", transform: "translateY(-80px) scale(1.3)" },
          "100%": { opacity: "0", transform: "translateY(-110px) scale(1)" },
        },
      },
      animation: {
        "float-up": "float-up 2.5s ease-out forwards",
      },
    },
  },
  variants: {
    extend: {},
  },
  // eslint-disable-next-line global-require
  plugins: [require("@tailwindcss/typography"), require("@tailwindcss/forms")],
}
