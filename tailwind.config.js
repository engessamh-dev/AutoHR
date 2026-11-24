/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,html}"],
  theme: {
    extend: {
      colors: {
        autohr: {
          bg: "var(--autohr-bg)",
          sidebar: "var(--autohr-sidebar)",
          card: "var(--autohr-card)",
          border: "var(--autohr-border)",
          green: "var(--autohr-green)",
          amber: "var(--autohr-amber)",
          red: "var(--autohr-red)",
        },
      },
    },
  },
  plugins: [],
};
