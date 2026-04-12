/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        /** Orange — ekstra lys til sol / udendørs */
        safety: "#FF6B35",
        safetyDeep: "#E85A24",
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
