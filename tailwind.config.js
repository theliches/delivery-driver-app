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
        /** Grøn «leveret» — høj synlighed */
        go: "#34D399",
        goDeep: "#059669",
      },
      boxShadow: {
        card: "0 4px 18px rgba(0,0,0,0.6)",
      },
    },
  },
  plugins: [],
};
