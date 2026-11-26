#!/usr/bin/env node
// Developer tool: signs a CNSArch admin-unlock challenge («نسيت كلمة مرور المسؤول»).
// NOT part of the program and never bundled with it. The private key stays on the developer's computer.
//
//   node tools/admin-unlock/unlock.mjs keygen [--out <folder>]
//   node tools/admin-unlock/unlock.mjs sign <CNS1-XXXXXX-XXXX-YYYYMMDD | photo.jpg | screenshot.png> [--key <private-key.pem>]
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicKeyFile = path.resolve(here, "../../src-tauri/unlock_public_key.txt");
const defaultFolder = path.join(os.homedir(), "CNSArch-unlock-key");
const defaultKey = path.join(defaultFolder, "private-key.pem");
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = message => { console.error(`خطأ: ${message}`); process.exit(1); };

function base32(bytes) {
  let out = "", bits = 0, count = 0;
  for (const b of bytes) {
    bits = (bits << 8) | b; count += 8;
    while (count >= 5) { count -= 5; out += BASE32[(bits >> count) & 31]; }
    bits &= (1 << count) - 1;
  }
  if (count > 0) out += BASE32[(bits << (5 - count)) & 31];
  return out;
}

function keygen() {
  const folder = path.resolve(option("--out") ?? defaultFolder);
  const keyPath = path.join(folder, "private-key.pem");
  if (fs.existsSync(keyPath)) fail(`يوجد مفتاح في ${keyPath}. لن أكتب فوقه، لأن النسخ المثبتة تعتمد عليه.`);
  if (folder.startsWith(path.resolve(here, "../.."))) fail("لا تضع المفتاح الخاص داخل مجلد المشروع. اختر مجلدًا خارجه بـ --out.");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  fs.writeFileSync(publicKeyFile, `${raw.toString("hex")}\n`);
  console.log(`المفتاح الخاص: ${keyPath}`);
  console.log(`المفتاح العام كُتب في: ${publicKeyFile}`);
  console.log("الخطوات التالية: احفظ نسخة من المفتاح الخاص على فلاشة في مكان آمن، ثم أرسل التغيير على unlock_public_key.txt وابنِ إصدارًا جديدًا.");
}

/** Reads the challenge from a photo or screenshot of the QR shown by the program. */
function readQr(file) {
  const require = createRequire(import.meta.url);
  let jsQR, PNG, jpeg;
  try {
    jsQR = require("jsqr"); PNG = require("pngjs").PNG; jpeg = require("jpeg-js");
  } catch {
    fail("لقراءة صورة QR شغّل أولًا: npm install (في مجلد المشروع). أو اكتب الرمز نصًا.");
  }
  const bytes = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  let image;
  if (ext === ".png") image = PNG.sync.read(bytes);
  else if (ext === ".jpg" || ext === ".jpeg") image = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 1024 });
  else fail("الصورة يجب أن تكون PNG أو JPG.");
  const found = jsQR(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length), image.width, image.height);
  if (!found?.data) fail("لم أجد رمز QR في الصورة. اطلب صورة أوضح، أو اطلب الرمز نصًا («عرض كنص» في البرنامج).");
  console.log(`قُرئ من الصورة: ${found.data}`);
  return found.data;
}

function sign() {
  const input = (args[1] ?? "").trim();
  const challenge = (/\.(png|jpe?g)$/i.test(input) && fs.existsSync(input) ? readQr(input) : input).trim().toUpperCase();
  if (!/^CNS1-[A-Z2-9]{6}-[0-9A-F]{4}-\d{8}$/.test(challenge)) fail("الرمز غير صحيح. يجب أن يكون مثل CNS1-K7QMPX-3FA2-20261126");
  const date = challenge.slice(-8);
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  if (Math.abs(Number(date) - Number(today)) > 1) console.warn(`تنبيه: الرمز بتاريخ ${date}، وهو يعمل في يومه فقط على جهاز المستخدم.`);
  const keyPath = path.resolve(option("--key") ?? defaultKey);
  if (!fs.existsSync(keyPath)) fail(`لم أجد المفتاح الخاص في ${keyPath}. استعمل --key <المسار>.`);
  const signature = crypto.sign(null, Buffer.from(challenge), crypto.createPrivateKey(fs.readFileSync(keyPath)));
  const code = base32(signature).match(/.{1,4}/g).join("-");
  console.log("رمز الفتح (أرسله كما هو):\n");
  console.log(code);
}

if (args[0] === "keygen") keygen();
else if (args[0] === "sign") sign();
else {
  console.log("الاستعمال:\n  node tools/admin-unlock/unlock.mjs keygen [--out <مجلد>]\n  node tools/admin-unlock/unlock.mjs sign <رمز الجهاز> [--key <private-key.pem>]");
}
