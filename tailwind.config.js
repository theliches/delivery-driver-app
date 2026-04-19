/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        /** Sættes fra App via --accent-rgb / --accent-deep-rgb (menu: accentfarve) */
        accent: "rgb(var(--accent-rgb) / <alpha-value>)",
        accentDeep: "rgb(var(--accent-deep-rgb) / <alpha-value>)",
        /** Diskret flade — sættes fra App (--accent-surface-rgb); grøn = #D6D6D6 */
        accentSurface: "rgb(var(--accent-surface-rgb) / <alpha-value>)",
        /** Grøn «leveret» — matcher grøn brand (22913A / 186929) */
        go: "#22913A",
        goDeep: "#186929",
      },
      boxShadow: {
        card: "0 4px 18px rgba(0,0,0,0.6)",
      },
    },
  },
  plugins: [],
};
