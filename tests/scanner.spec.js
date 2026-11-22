import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
const targets = [
  ["uploadCompanyLogo", ["synthetic.png"], "cmd_upload_company_logo"],
  ["uploadEmployeePhoto", [1, "synthetic.png"], "cmd_upload_employee_photo"],
  ["uploadAttachment", [1, "synthetic.png"], "cmd_upload_attachment"],
  ["uploadNationalCardAttachment", [1, "front", "synthetic.png"], "cmd_upload_national_card_attachment"],
  ["uploadResidenceCardAttachment", [1, "front", "synthetic.png"], "cmd_upload_residence_card_attachment"],
  ["uploadAirportBadgeAttachment", [1, "front", "synthetic.png"], "cmd_upload_airport_badge_attachment"],
  ["uploadMinistryBadgeAttachment", [1, "front", "synthetic.png"], "cmd_upload_ministry_badge_attachment"],
  ["uploadSpouseNationalCardAttachment", [1, 0, "front", "synthetic.png"], "cmd_upload_spouse_national_card_attachment"],
  ["uploadFamilyNationalCardAttachment", [1, 0, "front", "synthetic.png"], "cmd_upload_family_national_card_attachment"],
  ["uploadPassportAttachment", [1, "synthetic.png"], "cmd_upload_passport_attachment"],
  ["uploadRationCardAttachment", [1, "synthetic.png"], "cmd_upload_ration_card_attachment"],
  ["uploadGeneralDocFile", [1, "synthetic.png"], "cmd_upload_general_doc_file"],
  ["uploadOutgoingDocFile", [1, "synthetic.png"], "cmd_upload_outgoing_doc_file"],
];
test.beforeEach(async ({ page }) => { await page.goto("/tests/scanner-harness.html"); await page.waitForFunction(() => window.ready); });
async function run(page, method = "uploadAttachment", args = [1, "synthetic.png"]) {
  await page.evaluate(({ method, args }) => window.runUpload(method, args), { method, args });
  await page.getByRole("button", { name: "تحديد حدود المرفق وتدويره", exact: true }).click();
  await expect(page.getByRole("button", { name: "تطبيق القص / إعادة المعالجة" })).toBeVisible();
}
async function save(page) {
  await page.getByRole("button", { name: "تطبيق القص / إعادة المعالجة" }).click();
  await page.waitForFunction(() => window.result !== null || window.failure !== null);
}
for (const [method, args, command] of targets) test(`central upload bridge: ${method}`, async ({ page }) => {
  await run(page, method, args); await save(page);
  await expect(page.getByRole("button", { name: "\u0627\u0644\u0623\u0635\u0644 \u0648\u0627\u0644\u0646\u0633\u062e\u0629 \u0627\u0644\u062d\u0627\u0644\u064a\u0629", exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => window.calls);
  expect(calls.filter(c => c.command === "cmd_scanner_upload")).toHaveLength(1);
  const upload = calls.find(c => c.command === "cmd_scanner_upload"); expect(upload.args.command).toBe(command);
  expect(upload.args.context).not.toHaveProperty("sourcePath"); expect(calls.some(c => c.command === command)).toBe(false);
  expect(calls.at(-1).command).toBe("cmd_scanner_release");
  expect(await page.evaluate(() => window.failure)).toBeNull();
});
test("ordinary upload, disabled setting and nonimages are unchanged", async ({ page }) => {
  await page.evaluate(() => window.runUpload("uploadGeneralDocFile", [1, "original.pdf"]));
  await page.waitForFunction(() => window.result !== null);
  expect(await page.evaluate(() => window.calls)).toEqual([{ command: "cmd_upload_general_doc_file", args: { docId: 1, sourcePath: "original.pdf" } }]);
  for (const file of ["original.docx", "original.xlsx", "original.pptx"]) {
    await page.evaluate(file => { window.calls = []; window.runUpload("uploadGeneralDocFile", [1, file]); }, file);
    await page.waitForFunction(() => window.result !== null);expect(await page.evaluate(() => window.calls.length)).toBe(1);
  }
  await page.evaluate(() => { window.calls = []; window.runUpload("uploadAttachment", [1, "ready.webp"]); });
  await page.getByRole("button", { name: "رفع بالطريقة المعتادة" }).click(); await page.waitForFunction(() => window.result !== null);
  expect((await page.evaluate(() => window.calls)).at(-1).args.sourcePath).toBe("ready.webp");
  await page.evaluate(() => { window.settings.enabled = false; window.calls = []; window.runUpload("uploadAttachment", [1, "ready.jpg"]); });
  await page.waitForFunction(() => window.result !== null);expect(await page.getByRole("dialog").count()).toBe(0);
});
test("cancel at choice and editor never saves; focus restored", async ({ page }) => {
  await page.locator("#previous-focus").focus();
  await page.evaluate(() => window.runUpload("uploadAttachment", [1, "image.png"]));
  await page.getByRole("button", { name: "إلغاء الرفع" }).click();await page.waitForFunction(() => window.failure !== null);
  await expect(page.locator("#previous-focus")).toBeFocused();
  expect(await page.evaluate(() => window.calls.some(c => c.command.includes("upload")))).toBe(false);
  await run(page); await page.keyboard.press("Escape"); await page.waitForFunction(() => window.failure !== null);
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_scanner_upload"))).toBe(false);
  expect(await page.evaluate(() => window.calls.at(-1).command)).toBe("cmd_scanner_release");
});
test("failed detection uses full image; manual corners, rotation, zoom and reset", async ({ page }) => {
  await page.evaluate(() => { window.reliable = false; }); await run(page);
  await expect(page.locator("[data-status]")).toContainText("غير موثوق");
  await page.locator('[data-corner="0"]').focus(); await page.keyboard.press("Shift+ArrowRight"); await page.keyboard.press("Shift+ArrowDown");
  await page.locator("[data-rotate]").click(); await page.locator("[data-zoom]").fill("200");
  await expect(page.locator("[data-result]")).toBeVisible();
  const render = { args: { corners: await selectedCorners(page), rotation: 90 } };
  expect(render.args.corners).toEqual([[10, 10], [639, 0], [639, 479], [0, 479]]);expect(render.args.rotation).toBe(90);
  await page.locator('[data-corner="1"]').focus(); await page.keyboard.press("ArrowLeft"); await expect(page.locator("[data-save]")).toHaveCount(0);
  await page.locator("[data-reset]").click(); await save(page);
  expect((await page.evaluate(() => window.calls.filter(c => c.command === "cmd_scanner_render"))).at(-1).args.corners).toEqual([[0, 0], [639, 0], [639, 479], [0, 479]]);
});
test("pointer dragging and invalidating a preview", async ({ page }) => {
  await run(page); await expect(page.locator("[data-result]")).toBeVisible(); await page.locator("[data-result]").evaluate(image => image.decode()); await page.waitForTimeout(100); const handle = page.locator('[data-corner="0"]');const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);await page.mouse.down();await page.mouse.move(box.x + 40, box.y + 35);await page.mouse.up();
  await page.locator("[data-rotate]").click();await expect(page.locator("[data-result]")).toBeVisible();
  expect((await selectedCorners(page))[0][0]).toBeGreaterThan(100);
});
test("render/save errors never claim success", async ({ page }) => {
  await page.evaluate(() => { window.failRender = true; }); await run(page);
  await page.getByRole("button", { name: "تطبيق القص / إعادة المعالجة" }).click();await expect(page.locator("[data-error]")).toContainText("Injected processing failure");await expect(page.locator("[data-save]")).toHaveCount(0);
  await page.evaluate(() => { window.failRender = false; window.failSave = true; });await save(page);
  expect(await page.evaluate(() => window.result)).toBeNull();expect(await page.evaluate(() => window.failure)).toContain("database/Audit");
});
test("existing attachments retain exact association, and viewer cannot mutate", async ({ page }) => {
  for (const path of ["Files/Employees/1/Documents/NationalCard/card.png", "Files/GeneralDocs/1/document.jpg", "Files/OutgoingDocs/1/letter.webp"]) {
    await page.evaluate(path => window.runExisting(path), path);await save(page);
    const calls = await page.evaluate(() => window.calls);expect(calls.filter(c => c.command === "cmd_scanner_save_existing").at(-1).args.relativePath).toBe(path);
    expect(calls.some(c => c.command === "cmd_scanner_upload")).toBe(false);
  }
  await page.evaluate(() => window.bindExisting("Files/GeneralDocs/1/document.jpg", ["documents.view", "documents.upload"]));
  await expect(page.locator("[data-scanner-for] button")).toHaveCount(1);
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_scanner_versions"))).toBe(false);
  await page.evaluate(() => window.bindExisting("Files/GeneralDocs/1/document.jpg", ["documents.view"]));
  await expect(page.getByRole("button", { name: "إعادة معالجة المستمسك" })).toHaveCount(0);
  await expect(page.locator("[data-scanner-for]")).toHaveCount(0);
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_scanner_versions"))).toBe(false);
});
test("offline, responsive RTL and keyboard focus trap", async ({ page, context }) => {
  await context.setOffline(true);
  for (const width of [1200, 900, 640, 390]) {
    await page.setViewportSize({ width, height: 850 });await run(page);
    await expect(page.locator(".smart-scanner-overlay")).toHaveAttribute("dir", "rtl");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("[data-cancel]").focus();await page.keyboard.press("Tab");await expect(page.locator("[data-zoom]")).toBeFocused();
    await expect(page.locator("[data-detect]")).toHaveCount(0);await save(page);expect(await page.evaluate(() => window.failure)).toBeNull();
  }
});

for (const [selector,command] of [
  ["#btn-upload-photo","cmd_upload_employee_photo"],
  ['.btn-upload-sided-card[data-card-type="national"][data-side="front"]',"cmd_upload_national_card_attachment"],
  ['.btn-upload-sided-card[data-card-type="residence"][data-side="front"]',"cmd_upload_residence_card_attachment"],
  ['.btn-upload-sided-card[data-card-type="airport"][data-side="front"]',"cmd_upload_airport_badge_attachment"],
  ['.btn-upload-sided-card[data-card-type="ministry"][data-side="front"]',"cmd_upload_ministry_badge_attachment"],
  ["#btn-upload-passport","cmd_upload_passport_attachment"],
  ["#btn-upload-ration-card","cmd_upload_ration_card_attachment"],
  ['.btn-upload-family-card[data-side="front"]',"cmd_upload_family_national_card_attachment"],
  ['.btn-upload-spouse-card[data-side="front"]',"cmd_upload_spouse_national_card_attachment"],
]) test(`actual employee screen entry: ${command}`, async ({page})=>{
  await page.evaluate(()=>window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator(`.tab-btn[data-tab="${command.includes("family")||command.includes("spouse")?"family":"documents"}"]`).click();
  await page.locator(selector).first().click();
  await page.getByRole("button",{name:"تأكيد",exact:true}).click();
  await page.getByRole("button",{name:"تحديد حدود المرفق وتدويره",exact:true}).click();
  await expect(page.locator("[data-process]")).toBeVisible();
  expect((await page.evaluate(()=>window.calls.find(c=>c.command==="cmd_scanner_prepare"))).args.kind).toBe(command);
  await page.locator("[data-cancel]").click();
});
for(const screen of ["general","outgoing"])test(`archive supports live processing and upload: ${screen}`,async({page})=>{
  await page.evaluate(screen=>window.renderActual(screen),screen);
  await page.locator(".att-act-more").first().click();
  await page.getByRole("menuitem",{name:"قص وتدوير الصورة"}).click();
  await expect(page.locator("[data-result]")).toBeVisible();
  await expect(page.locator("[data-save]")).toHaveCount(0);
  await page.locator("[data-process]").click();
  await page.waitForFunction(()=>window.calls.some(c=>c.command==="cmd_scanner_save_existing"));
  await expect(page.locator(".smart-scanner-overlay")).toHaveCount(0);
  await page.locator("#attachment-manager-add").click();
  await page.getByRole("button",{name:"\u062a\u0623\u0643\u064a\u062f",exact:true}).click();
  await page.locator('[data-choice="scan"]').click();
  await expect(page.locator("[data-result]")).toBeVisible();
  await page.locator("[data-process]").click();
  const command = screen === "outgoing" ? "cmd_upload_outgoing_doc_file" : "cmd_upload_general_doc_file";
  await page.waitForFunction(command => window.calls.some(c => c.command === "cmd_scanner_upload" && c.args.command === command), command);
});
for(const [method, command] of [["uploadDocumentAttachment","cmd_upload_attachment"]])test(`document image bypasses editor: ${method}`,async({page})=>{
  await page.evaluate(method=>window.runUpload(method,[1,"synthetic.png"]),method);
  await page.waitForFunction(()=>window.result!==null);
  expect(await page.evaluate(()=>window.calls)).toEqual([{command,args:command === "cmd_upload_attachment" ? {employeeId:1,sourcePath:"synthetic.png"} : {docId:1,sourcePath:"synthetic.png"}}]);
  await expect(page.locator(".smart-scanner-overlay")).toHaveCount(0);
});
test("about screen removes attachment processing settings and preserves logo upload",async({page})=>{
  await page.evaluate(()=>window.renderActual("about"));
  await expect(page.locator("#scanner-settings")).toHaveCount(0);
  for (const selector of ["[data-confidence]","[data-auto]","[data-quality]","[data-enhancement]"]) await expect(page.locator(selector)).toHaveCount(0);
  await page.locator("#btn-upload-logo").click();await page.getByRole("button",{name:"\u062a\u0623\u0643\u064a\u062f",exact:true}).click();
  await page.locator('[data-choice="scan"]').click();await expect(page.locator("[data-process]")).toBeVisible();
  await expect(page.locator("[data-detect]")).toHaveCount(0);await page.locator("[data-cancel]").click();
});
test("existing employee document opens the same editor and preserves its association",async({page})=>{
  await page.evaluate(()=>window.renderActual("employees"));await page.locator('.table-row[data-id="1"]').click();await page.locator('.tab-btn[data-tab="documents"]').click();
  await page.locator('[data-scanner-for="Files/Employees/1/Documents/NationalCard/card.jpg"] button').filter({hasText:"إعادة معالجة"}).click();
  await page.locator("[data-process]").click();
  await page.waitForFunction(()=>window.calls.some(c=>c.command==="cmd_scanner_save_existing"));
  expect((await page.evaluate(()=>window.calls.find(c=>c.command==="cmd_scanner_save_existing"))).args.relativePath).toBe("Files/Employees/1/Documents/NationalCard/card.jpg");
});


test("portrait and landscape fit, overlay mapping at zoom", async ({ page }) => {
  await page.setViewportSize({width:900,height:600});
  for (const [width, height] of [[2400, 4000], [4000, 1200]]) {
    await page.evaluate(({width,height}) => {
      const canvas=document.createElement("canvas"); canvas.width=width/4; canvas.height=height/4;
      const ctx=canvas.getContext("2d"); ctx.fillStyle="#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
      window.prepared={token:"geometry-test",width,height,corners:[[width*.2,height*.2],[width*.8,height*.2],[width*.8,height*.8],[width*.2,height*.8]],confidence:.9,reliable:true,settings:window.settings,preview:Array.from(Uint8Array.from(atob(canvas.toDataURL("image/jpeg").split(",")[1]), c=>c.charCodeAt(0)))};
    }, {width,height});
    await run(page);
    await expect.poll(async () => page.locator(".smart-scanner-image").evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(0);
    const geometry=await page.evaluate(() => {
      const el=document.querySelector(".smart-scanner-image"), vp=document.querySelector(".smart-scanner-scroll");
      const b=el.getBoundingClientRect(),v=vp.getBoundingClientRect();
      return {fit:b.left>=v.left+10 && b.right<=v.right-10 && b.top>=v.top+10 && b.bottom<=v.bottom-10,ratio:b.width/b.height};
    });
    const action=await page.locator("[data-cancel]").boundingBox();
    expect(action.y+action.height).toBeLessThan(600);
    expect(geometry.fit).toBe(true); expect(geometry.ratio).toBeCloseTo(width/height,2);
    await page.locator("[data-zoom]").fill("200");
    const box=await page.locator(".smart-scanner-image").boundingBox();
    const handle=await page.locator('[data-corner="0"]').boundingBox();
    const x=handle.x+handle.width/2,y=handle.y+handle.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+20,y+15);await page.mouse.up();
    await page.locator("[data-rotate]").click();await expect(page.locator("[data-result]")).toBeVisible();
    const c=(await selectedCorners(page))[0];
    expect(c[0]).toBeCloseTo(width*.2+20/box.width*(width-1),0);
    expect(c[1]).toBeCloseTo(height*.2+15/box.height*(height-1),0);
    await page.locator("[data-zoom]").fill("50");await page.locator("[data-fit]").click();
    await expect(page.locator("[data-zoom]")).toHaveValue("100");
    await page.locator("[data-cancel]").click();
  }
});

test("failed localization is visibly manual and requires preview approval", async ({page}) => {
  await page.evaluate(()=>window.reliable=false);await run(page);
  await expect(page.locator(".smart-scanner-image")).toHaveClass(/is-manual/);
  await expect(page.locator("[data-save]")).toHaveCount(0);
  expect(await page.locator("[data-selected]").evaluate(el=>getComputedStyle(el).stroke)).toBe("rgb(251, 191, 36)");
  await page.locator("[data-reset]").click();await expect(page.locator("[data-status]")).toContainText("نقطة بداية");
});


test("corner mapping uses CSS coordinates at device pixel ratio two", async ({browser}) => {
  const context=await browser.newContext({deviceScaleFactor:2,viewport:{width:1000,height:700}});
  const page=await context.newPage();await page.goto("/tests/scanner-harness.html");await page.waitForFunction(()=>window.ready);
  await run(page);await page.locator("[data-zoom]").fill("150");
  const image=await page.locator(".smart-scanner-image").boundingBox();
  const handle=await page.locator('[data-corner="0"]').boundingBox();
  const x=handle.x+handle.width/2,y=handle.y+handle.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+20,y+15);await page.mouse.up();
  await page.locator("[data-rotate]").click();await expect(page.locator("[data-result]")).toBeVisible();
  const c=(await selectedCorners(page))[0];
  expect(c[0]).toBeCloseTo(100+20/image.width*639,0);expect(c[1]).toBeCloseTo(70+15/image.height*479,0);
  await context.close();
});

// Private opt-in: feed the actual Rust result into the shared dialog, with mocked IPC.
// This checks real-image overlay/render display without opening any database.
test("actual image backend result fits shared scanner preview", async ({page}) => {
  test.skip(!process.env.SCANNER_TEST_IMAGE, "Supply SCANNER_TEST_IMAGE after running the ignored Rust image test");
  const metrics=JSON.parse(readFileSync(".scanner-local/actual-metrics.json", "utf8"));
  const debug=JSON.parse(readFileSync(".scanner-local/actual-debug.json", "utf8"));
  const preview=Array.from(readFileSync(process.env.SCANNER_TEST_IMAGE));
  const renderBytes=Array.from(readFileSync(".scanner-local/actual-crop.png"));
  await page.setViewportSize({width:1100,height:800});
  await page.evaluate(({metrics,debug,preview,renderBytes}) => {
    window.prepared={token:"private-verification",width:metrics.dimensions[0],height:metrics.dimensions[1],corners:metrics.corners,confidence:metrics.confidence,reliable:true,settings:window.settings,preview,debug};
    window.renderBytes=renderBytes;
  }, {metrics,debug,preview,renderBytes});
  await run(page);
  await expect(page.locator(".smart-scanner-image")).not.toHaveClass(/is-manual/);
  await expect(page.locator("[data-original]")).toBeVisible();
  const bounds=await page.locator(".smart-scanner-image").boundingBox();
  for(let i=0;i<4;i++){
    const h=await page.locator(`[data-corner="${i}"]`).boundingBox();
    expect(h.x+h.width/2).toBeCloseTo(bounds.x+metrics.corners[i][0]/(metrics.dimensions[0]-1)*bounds.width,0);
    expect(h.y+h.height/2).toBeCloseTo(bounds.y+metrics.corners[i][1]/(metrics.dimensions[1]-1)*bounds.height,0);
  }
  await page.locator("[data-rotate]").click();await expect(page.locator("[data-result]")).toBeVisible();
  await expect(page.locator("[data-process]")).toBeEnabled();
  const call={args:{corners:await selectedCorners(page),rotation:90}};
  expect(call.args.corners).toEqual(metrics.corners);
  await page.screenshot({path:".scanner-local/actual-ui.png"});
  await page.locator("[data-cancel]").click();
  expect(await page.evaluate(()=>window.calls.some(c=>c.command==="cmd_scanner_upload"))).toBe(false);
});


// Compile only a component in memory with its Production feature flag. No app/release build.
async function productionModule(page, entry, key) {
  const result=await build({entryPoints:[entry],bundle:true,write:false,format:"esm",platform:"browser",define:{"import.meta.env.DEV":"false","import.meta.env.VITE_APP_VERSION":JSON.stringify("1.0.1")}});
  await page.evaluate(async ({code,key})=>{
    const url=URL.createObjectURL(new Blob([code],{type:"text/javascript"}));
    try { window[key]=await import(url); } finally { URL.revokeObjectURL(url); }
  }, {code:result.outputFiles[0].text,key});
}

test("Production manual editor ignores detected corners and only crops after approval", async ({page})=>{
  await productionModule(page,"src/attachments/scanner.js","productionScanner");
  await page.evaluate(()=>{
    window.productionScanner.uploadWithScanner("cmd_upload_general_doc_file",{docId:1,sourcePath:"synthetic.png"}).then(v=>window.result=v).catch(e=>window.failure=String(e));
  });
  await page.locator('[data-choice="scan"]').click();
  await expect(page.locator("[data-original]")).toBeVisible();
  await expect(page.locator("[data-detect]")).toHaveCount(0);
  await expect(page.locator("[data-debug]")).toHaveCount(0);
  await expect(page.locator("[data-save]")).toHaveCount(0);
  expect(await page.locator("[data-selected]").getAttribute("points")).toBe("0,0 639,0 639,479 0,479");
  expect(await page.locator("[data-status]").textContent()).not.toContain("Development");
  await page.locator('[data-corner="0"]').focus();await page.keyboard.press("Shift+ArrowRight");await page.keyboard.press("Shift+ArrowDown");
  await page.locator("[data-rotate]").click();
  await expect(page.locator("[data-result]")).toBeVisible();
  const call={args:{corners:await selectedCorners(page),rotation:90}};
  expect(call.args.corners).toEqual([[10,10],[639,0],[639,479],[0,479]]);expect(call.args.rotation).toBe(90);
  await expect(page.locator("[data-process]")).toBeEnabled();await page.locator("[data-process]").click();
  await page.waitForFunction(()=>window.result!==null);
  expect(await page.evaluate(()=>window.calls.some(c=>c.command==="cmd_scanner_detect"))).toBe(false);
  expect(await page.evaluate(()=>window.calls.filter(c=>c.command==="cmd_scanner_upload").length)).toBe(1);
});

test("Production about screen has no attachment processing settings", async ({page})=>{
  await productionModule(page,"src/screens/about.js","productionAbout");
  await page.evaluate(async()=>{
    await window.productionAbout.renderAbout(document.querySelector("#root"),{permissions:["settings.manage"]},{});
  });
  await expect(page.locator("#scanner-settings")).toHaveCount(0);
  for(const selector of ["[data-auto]","[data-confidence]","[data-enhancement]","[data-quality]"])await expect(page.locator(selector)).toHaveCount(0);
});


test("live preview updates corners and rotation without rendering or saving", async ({ page }) => {
  await run(page);
  const result = page.locator("[data-result]");
  await expect(result).toBeVisible();
  const before = await result.getAttribute("src");
  await page.locator('[data-corner="0"]').focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(result).not.toHaveAttribute("src", before);
  const edited = await result.getAttribute("src");
  await page.locator("[data-rotate]").click();
  await expect(result).not.toHaveAttribute("src", edited);
  await result.evaluate(image => image.decode());
  expect(await result.evaluate(image => image.naturalHeight > image.naturalWidth)).toBe(true);
  expect(await page.evaluate(() => window.calls.some(c => ["cmd_scanner_render", "cmd_scanner_upload"].includes(c.command)))).toBe(false);
  await page.evaluate(() => { window.failRender = true; });
  await page.locator("[data-process]").click();
  await expect(page.locator("[data-error]")).toContainText("Injected processing failure");
  await expect(result).toBeVisible();
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_scanner_upload"))).toBe(false);
  await page.evaluate(() => { window.failRender = false; });
  await page.locator("[data-process]").click();
  await page.waitForFunction(() => window.result !== null);
  const render = await page.evaluate(() => window.calls.filter(c => c.command === "cmd_scanner_render").at(-1));
  expect(render.args.rotation).toBe(90);
  expect(render.args.corners[0]).toEqual([110,70]);
});
async function selectedCorners(page) {
  return page.locator("[data-selected]").evaluate(el => el.getAttribute("points").split(" ").map(point => point.split(",").map(Number)));
}

test("live preview refreshes during pointer drag before release", async ({ page }) => {
  await run(page);
  const result = page.locator("[data-result]");
  await expect(result).toBeVisible();
  await result.evaluate(image => image.decode());
  await page.waitForTimeout(100);
  const handle = await page.locator('[data-corner="0"]').boundingBox();
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  const before = await result.getAttribute("src");
  await page.mouse.move(x,y); await page.mouse.down();
  await page.mouse.move(x + 25,y + 15);
  await expect(result).not.toHaveAttribute("src", before);
  const midway = await result.getAttribute("src");
  await page.mouse.move(x + 45,y + 30);
  await expect(result).not.toHaveAttribute("src", midway);
  await expect(page.locator('[data-corner="0"]')).toBeEnabled();
  await page.mouse.up();
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_scanner_render" || c.command === "cmd_scanner_upload"))).toBe(false);
  await page.locator("[data-cancel]").click();
});

test("personal photo reprocesses and delete clears the visible photo", async ({ page }) => {
  await page.evaluate(()=>window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator('.tab-btn[data-tab="documents"]').click();
  const photo = page.locator('[data-scanner-for="Files/Employees/1/Photo/photo.jpg"] button');
  await photo.click();
  await expect(page.locator("[data-result]")).toBeVisible();
  await page.locator("[data-process]").click();
  await page.waitForFunction(()=>window.calls.some(c=>c.command==="cmd_scanner_save_existing"));
  expect(await page.evaluate(()=>window.calls.find(c=>c.command==="cmd_scanner_prepare").args.relativePath)).toBe("Files/Employees/1/Photo/photo.jpg");
  await page.locator("#btn-delete-photo").click();
  await page.getByRole("button",{name:"\u062a\u0623\u0643\u064a\u062f",exact:true}).click();
  await expect(page.locator("#btn-delete-photo")).toHaveCount(0);
  await expect(page.locator('img[data-scan-path="Files/Employees/1/Photo/photo.jpg"]')).toHaveCount(0);
  expect(await page.evaluate(()=>window.calls.find(c=>c.command==="cmd_delete_employee_photo").args)).toEqual({employeeId:1});
});

test("all employee image attachment types open reprocessing", async ({ page }) => {
  for (const relative of ["Photo/photo.jpg", "Documents/NationalCard/card.png", "Documents/ResidenceCard/card.webp", "Documents/AirportBadge/card.jpg", "Documents/MinistryBadge/card.jpg", "Documents/Passport/card.jpg", "Documents/RationCard/card.jpg", "Spouses/1/card.jpg", "Family/1/card.jpg"]) {
    const path = "Files/Employees/1/" + relative;
    await page.evaluate(path=>window.bindExisting(path,{permissions:["employees.edit","documents.upload"]}.permissions),path);
    const process = page.locator("[data-scanner-for] button");
    await expect(process).toHaveCount(1);
    await process.click();
    await expect(page.locator("[data-result]")).toBeVisible();
    expect(await page.evaluate(()=>window.calls.filter(c=>c.command==="cmd_scanner_prepare").at(-1).args.relativePath)).toBe(path);
    await page.locator("[data-cancel]").click();
    await expect(page.locator(".smart-scanner-overlay")).toHaveCount(0);
  }
});
