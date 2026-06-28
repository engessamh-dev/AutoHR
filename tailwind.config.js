/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,html}"],
  theme: {
    extend: {
      colors: {
        autohr: {
          bg: "#020c1b",
          sidebar: "#061a32",
          card: "#08213d",
          border: "#244e73",
          green: "#24a9ff",
          amber: "#d97706",
          red: "#f87171",
        },
      },
    },
  },
  plugins: [],
};
