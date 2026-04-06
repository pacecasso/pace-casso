/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        pace: {
          warm: "#f7f4ee",
          cream: "#f7f4ee",
          yellow: "#ffb800",
          blue: "#1d6fd8",
          ink: "#0d0d0d",
          line: "#e8e3da",
          white: "#ffffff",
          panel: "#fafaf8",
          muted: "#666666",
          "muted-light": "#888888",
        },
      },
      fontFamily: {
        anton: ["var(--font-anton)", "Anton", "Impact", "sans-serif"],
        bebas: ["var(--font-bebas)", "Bebas Neue", "sans-serif"],
        marker: ["var(--font-marker)", "Permanent Marker", "cursive"],
        dm: ["var(--font-dm-sans)", "DM Sans", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

