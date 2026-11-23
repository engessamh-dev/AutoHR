/**
 * branding.js — Fixed company logo (GCAAN), bundled with the app.
 *
 * The logo is part of the build and cannot be changed from the UI or the backend.
 * Sizes:
 *  - small  (128×128, square, white background) — sidebar (36px, crisp up to ~3.5× DPI)
 *  - medium (256×256, square, white background) — Settings and About (72–96px, HiDPI)
 *  - print  (original 613×556)                  — printed reports (≈30 mm wide ≈ 500 dpi)
 */
import logoSmall  from "./assets/branding/company-logo-128.png";
import logoMedium from "./assets/branding/company-logo-256.png";
import logoPrint  from "./assets/branding/company-logo.png";

export const COMPANY_LOGO = Object.freeze({
  small: logoSmall,
  medium: logoMedium,
  print: logoPrint,
  alt: "شعار الشركة العامة لإدارة المطارات والملاحة الجوية",
});
