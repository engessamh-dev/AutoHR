/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,html}"],
  theme: {
    extend: {
      colors: {
        autohr: {
          bg: "#181818",
          sidebar: "#1f1f1f",
          card: "#222222",
          border: "#2d2d2d",
          green: "#5da12c",
          amber: "#d97706",
          red: "#dc2626",
        },
      },
    },
  },
  plugins: [],
};
