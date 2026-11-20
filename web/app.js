"use strict";
const { parseIntelHex, SerialLink, IspProgrammer, BootloaderUploader, sleep } = window.STK500;
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("progattiny." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("progattiny." + k, JSON.stringify(v)); } catch (e) {} }
};
const hex2 = n => "0x" + n.toString(16).toUpperCase().padStart(2, "0");

/* ------------------------------------------------------------ exemples */
const EXAMPLES = {
  blink: { name: "Blink (broche 2 / PB3)", code:
`// LED + résistance 330 ohms sur PB3 (broche physique 2)
#define LED 3

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, HIGH);
  delay(500);
  digitalWrite(LED, LOW);
  delay(500);
}
` },
  fade: { name: "Fade PWM (broche 5 / PB0)", code:
`// Variation de lumière en PWM sur PB0 (broche physique 5)
#define LED 0

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  for (int i = 0; i <= 255; i++) { analogWrite(LED, i); delay(4); }
  for (int i = 255; i >= 0; i--) { analogWrite(LED, i); delay(4); }
}
` },
  button: { name: "Bouton → LED", code:
`// Bouton entre PB4 (broche 3) et GND, LED sur PB3 (broche 2)
#define BOUTON 4
#define LED    3

void setup() {
  pinMode(BOUTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, digitalRead(BOUTON) == LOW ? HIGH : LOW);
}
` },
  empty: { name: "Programme vide", code: "void setup() {\n\n}\n\nvoid loop() {\n\n}\n" }
};
const PINS = ["PB5 / RESET", "PB3 / A3", "PB4 / A2", "GND", "PB0 / MOSI", "PB1 / MISO", "PB2 / SCK", "VCC"];
const USB_NAMES = {
  "2341:0043": "Arduino Uno", "2341:0001": "Arduino Uno", "2a03:0043": "Arduino Uno", "2341:0243": "Arduino Uno",
  "2341:0058": "Arduino Nano", "1a86:7523": "CH340 (Nano / Uno clone)", "1a86:55d4": "CH9102 (Nano clone)",
  "0403:6001": "FTDI (Nano)", "10c4:ea60": "CP2102"
};
const SIGNATURES = { "1e930b": "ATtiny85", "1e9206": "ATtiny45", "1e9108": "ATtiny25", "1e9007": "ATtiny13", "1e950f": "ATmega328P" };

/* ------------------------------------------------------------ état */
let INFO = null, port = null, busy = false, editor = null, errMarks = [];

/* ------------------------------------------------------------ éditeur */
function initEditor() {
  const initial = store.get("code", EXAMPLES.blink.code);
  if (window.CodeMirror) {
    $("fallback").remove();
    editor = CodeMirror($("editorWrap"), {
      value: initial, mode: "text/x-c++src", theme: "material-darker", lineNumbers: true,
      matchBrackets: true, autoCloseBrackets: true, indentUnit: 2, tabSize: 2
    });
    editor.on("change", () => { store.set("code", editor.getValue()); clearErrors(); });
  } else {
    const ta = $("fallback"); ta.value = initial;
    ta.addEventListener("input", () => store.set("code", ta.value));
    editor = { getValue: () => ta.value, setValue: v => { ta.value = v; store.set("code", v); } };
  }
}
function clearErrors() { if (editor.removeLineClass) errMarks.forEach(l => editor.removeLineClass(l, "background", "err-line")); errMarks = []; }
function markErrors(errs) {
  clearErrors(); if (!editor.addLineClass) return;
  errs.forEach(e => { editor.addLineClass(e.line - 1, "background", "err-line"); errMarks.push(e.line - 1); });
  if (errs.length) editor.scrollIntoView({ line: errs[0].line - 1, ch: 0 }, 80);
}

/* ------------------------------------------------------------ console */
function log(text, cls) {
  const c = $("console"), s = document.createElement("span");
  if (cls) s.className = cls; s.textContent = text; c.appendChild(s); c.scrollTop = c.scrollHeight;
}
function clearLog() { $("console").textContent = ""; setBar(0); }
function setBar(f) { $("bar").style.width = Math.round(f * 100) + "%"; }
let lastStage = "";
function progress(stage, f) {
  setBar(f);
  if (stage !== lastStage) { log(stage + "…\n", "dim"); lastStage = stage; }
}

function setBusy(b, label) {
  busy = b;
  ["btnCompile", "btnUpload", "btnFuses", "btnIsp", "btnNormal", "btnCheck", "btnPort"].forEach(id => $(id).disabled = b);
  if (b) setBadge("busy", label || "En cours…");
}
function setBadge(kind, text) { const el = $("badge"); el.className = "badge " + kind; el.querySelector("span").textContent = text; }

/* ------------------------------------------------------------ port série */
function portLabel(p) {
  if (!p) return "aucun port";
  const i = p.getInfo();
  if (!i.usbVendorId) return "port série";
  const k = i.usbVendorId.toString(16).padStart(4, "0") + ":" + i.usbProductId.toString(16).padStart(4, "0");
  return USB_NAMES[k] || ("USB " + k);
}
function setPort(p) {
  port = p;
  $("portName").textContent = portLabel(p);
  if (!p) { setBadge("", "Non connecté"); return; }
  const name = portLabel(p);
  if (/uno/i.test(name)) $("board").value = "uno";
  else if (/nano|ch340|ch9102/i.test(name) && $("board").value === "uno") $("board").value = "nano_old";
  store.set("board", $("board").value);
  setBadge("", "Port choisi");
}
async function choosePort() {
  if (!("serial" in navigator)) { $("banner").classList.add("show"); return false; }
  try {
    const p = await navigator.serial.requestPort();
    closeModal(); setPort(p);
    log("Port choisi : " + portLabel(p) + "\n", "ok");
    checkProgrammer();
    return true;
  } catch (e) { return false; }   // l'utilisateur a annulé
}
async function needPort() {
  if (port) return true;
  openModal(); return false;
}
function openModal(title, text) {
  if (title) $("pmTitle").textContent = title;
  if (text) $("pmText").textContent = text;
  $("portModal").classList.add("open"); $("pmChoose").focus();
}
function closeModal() { $("portModal").classList.remove("open"); }

async function withLink(baud, fn) {
  const link = new SerialLink(port);
  try { await link.open(baud); }
  catch (e) {
    throw new Error("Impossible d'ouvrir le port : il est peut-être utilisé par un autre logiciel " +
      "(Arduino IDE, moniteur série) ou débranché.");
  }
  try { return await fn(link); } finally { await link.close(); }
}

/* ------------------------------------------------------------ compilation */
function params() { return { target: $("target").value, clock: $("clock").value }; }
function targetInfo() { return INFO.targets[$("target").value]; }

async function compileCode() {
  log("Compilation pour " + targetInfo().name + " (" + targetInfo().clocks[$("clock").value].label + ")…\n", "cmd");
  const r = await fetch("api/compile", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params(), code: editor.getValue() })
  });
  const j = await r.json();
  if (j.error) { log(j.error + "\n", "bad"); return null; }
  const lines = (j.log || "").split("\n").filter(l => l.trim());
  if (!j.ok) {
    lines.forEach(l => log(l + "\n", /error|erreur/i.test(l) ? "bad" : ""));
    (j.hints || []).forEach(h => log("→ " + h + "\n", "hint"));
    markErrors(j.errors || []);
    return null;
  }
  lines.filter(l => /octets|bytes/i.test(l)).forEach(l => log(l + "\n"));
  log(`Compilé en ${j.seconds} s.\n`, "ok");
  return j.hex;
}

async function compile() {
  if (busy) return;
  setBusy(true, "Compilation…"); clearLog(); clearErrors();
  try { if (await compileCode()) log("✔ Compilation réussie\n", "ok"); }
  catch (e) { log("Serveur injoignable : " + e.message + "\n", "bad"); }
  finally { setBusy(false); restoreBadge(); }
}

/* ------------------------------------------------------------ programmation ATtiny */
async function ispSession(link, t) {
  const isp = new IspProgrammer(link);
  if (!(await isp.connect())) {
    const err = new Error("L'Arduino ne répond pas comme programmateur.");
    err.hints = ["Cliquez sur « Passer en mode programmateur », puis remettez le condensateur 10 µF entre RESET et GND.",
      "Si c'est un Nano, vérifiez le choix « Nano / Nano (ancien bootloader) »."];
    throw err;
  }
  await isp.setDevice(t);
  await isp.enter();
  const sig = await isp.signature();
  const sigHex = sig.map(x => x.toString(16).padStart(2, "0")).join("");
  if (sigHex === "000000" || sigHex === "ffffff") {
    await isp.leave();
    const err = new Error("Aucun ATtiny détecté (signature 0x" + sigHex + ").");
    err.hints = ["Vérifiez le sens de la puce (le point = broche 1), le câblage D10–D13 et l'alimentation 5V / GND."];
    throw err;
  }
  const chip = SIGNATURES[sigHex] || ("puce inconnue 0x" + sigHex);
  log("Puce détectée : " + chip + "\n", "ok");
  const want = t.signature.map(x => x.toString(16).padStart(2, "0")).join("");
  if (sigHex !== want) {
    await isp.leave();
    const err = new Error(`La puce branchée (${chip}) ne correspond pas à la cible ${t.name}.`);
    err.hints = ["Changez la puce sélectionnée en haut de l'éditeur."];
    throw err;
  }
  return isp;
}

function reportError(e) {
  log("\n✖ " + e.message + "\n", "bad");
  (e.hints || []).forEach(h => log("→ " + h + "\n", "hint"));
  setBadge("err", "Échec");
}

async function upload() {
  if (busy || !(await needPort())) return;
  setBusy(true, "Compilation…"); clearLog(); clearErrors(); lastStage = "";
  try {
    const hex = await compileCode();
    if (!hex) { setBadge("err", "Erreur de code"); return; }
    const t = targetInfo();
    const data = parseIntelHex(hex);
    if (data.length > t.flash) throw new Error("Programme trop gros pour " + t.name);
    setBusy(true, "Téléversement…");
    log("Connexion au programmateur…\n", "cmd");
    await withLink(19200, async link => {
      const isp = await ispSession(link, t);
      progress("Effacement", 0);
      await isp.chipErase();
      await isp.writeFlash(data, t.page, progress);
      await isp.verifyFlash(data, t.page, progress);
      await isp.leave();
    });
    log(`\n✔ ${data.length} octets écrits et vérifiés. Le programme tourne sur l'${t.name} !\n`, "ok");
    setBadge("isp", "Téléversé ✓");
  } catch (e) { reportError(e); }
  finally { setBusy(false); }
}

async function burnFuses() {
  if (busy || !(await needPort())) return;
  const t = targetInfo(), c = t.clocks[$("clock").value];
  if (!confirm(`Graver les fusibles de l'${t.name} pour ${c.label} ?\nLe programme actuel de la puce sera effacé.`)) return;
  setBusy(true, "Fusibles…"); clearLog(); lastStage = "";
  try {
    log("Connexion au programmateur…\n", "cmd");
    await withLink(19200, async link => {
      const isp = await ispSession(link, t);
      progress("Effacement", .3);
      await isp.chipErase();
      progress("Écriture des fusibles", .6);
      await isp.writeFuses(c.fuses);
      const f = await isp.readFuses();
      await isp.leave();
      const okL = f.lfuse === c.fuses.lfuse, okH = f.hfuse === c.fuses.hfuse;
      log(`lfuse ${hex2(f.lfuse)}  hfuse ${hex2(f.hfuse)}` + (c.fuses.efuse !== undefined ? `  efuse ${hex2(f.efuse)}` : "") + "\n");
      if (!okL || !okH) throw new Error("Les fusibles relus ne correspondent pas aux valeurs écrites.");
      setBar(1);
    });
    log(`\n✔ Fusibles gravés : ${t.name} à ${c.label}.\n`, "ok");
    store.set("fused." + $("target").value, $("clock").value);
    setBadge("isp", "Fusibles ✓");
  } catch (e) { reportError(e); }
  finally { setBusy(false); }
}

/* ------------------------------------------------------------ vérification programmateur */
async function checkProgrammer() {
  if (busy || !port) return;
  setBusy(true, "Vérification…");
  try {
    await withLink(19200, async link => {
      const isp = new IspProgrammer(link);
      if (!(await isp.connect())) {
        setBadge("normal", "Mode normal");
        $("statusMsg").textContent = "L'Arduino ne répond pas comme programmateur : il est en mode normal (ou le condensateur 10 µF manque). Cliquez sur « Passer en mode programmateur ».";
        log("L'Arduino est en mode normal.\n", "hint");
        return;
      }
      await isp.setDevice(INFO.targets.attiny85);
      await isp.enter();
      const sig = (await isp.signature()).map(x => x.toString(16).padStart(2, "0")).join("");
      await isp.leave();
      const chip = SIGNATURES[sig];
      if (sig === "000000" || sig === "ffffff") {
        setBadge("normal", "Programmateur ✓ · pas de puce");
        $("statusMsg").textContent = "Programmateur OK, mais aucun ATtiny détecté. Vérifiez la puce et le câblage.";
      } else {
        setBadge("isp", "Programmateur ✓ · " + (chip || "0x" + sig));
        $("statusMsg").textContent = "Programmateur OK, puce détectée : " + (chip || "inconnue (0x" + sig + ")") + ".";
        if (chip === "ATtiny85" || chip === "ATtiny13") {
          const k = chip.toLowerCase();
          if ($("target").value !== k) { $("target").value = k; onTargetChange(); log("Cible réglée automatiquement sur " + chip + ".\n", "ok"); }
        }
      }
      log($("statusMsg").textContent + "\n", "ok");
    });
  } catch (e) { reportError(e); $("statusMsg").textContent = e.message; }
  finally { setBusy(false); }
}
function restoreBadge() { if (!port) setBadge("", "Non connecté"); else if ($("badge").classList.contains("busy")) setBadge("", "Prêt"); }

/* ------------------------------------------------------------ modes de l'Arduino */
async function flashBoard(kind) {
  if (busy || !(await needPort())) return;
  const b = INFO.boards[$("board").value];
  const what = kind === "isp" ? "installer ArduinoISP (mode programmateur)" : "remettre l'Arduino en mode normal";
  if (!confirm(`${b.name} : ${what} ?\n\n⚠ Retirez d'abord le condensateur 10 µF entre RESET et GND.`)) return;
  setBusy(true, kind === "isp" ? "Installation…" : "Mode normal…"); clearLog(); lastStage = "";
  try {
    log("Préparation du programme " + (kind === "isp" ? "ArduinoISP" : "vide") + " pour " + b.name + "…\n", "cmd");
    const r = await fetch("api/firmware", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: $("board").value, kind }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Compilation du firmware impossible.");
    const data = parseIntelHex(j.hex);
    log("Connexion au bootloader (" + b.baud + " bauds)…\n", "cmd");
    await withLink(b.baud, async link => {
      const bl = new BootloaderUploader(link);
      if (!(await bl.resetAndSync())) {
        const err = new Error("Le bootloader de l'Arduino ne répond pas.");
        err.hints = ["Retirez le condensateur 10 µF entre RESET et GND (il empêche le redémarrage).",
          "Pour un Nano clone, essayez « Nano (ancien bootloader) » ; sinon « Nano »."];
        throw err;
      }
      await bl.enter();
      await bl.writeFlash(data, b.page, progress);
      await bl.verifyFlash(data, b.page, progress);
      await bl.leave();
    });
    if (kind === "isp") {
      log("\n✔ L'Arduino est maintenant un PROGRAMMATEUR.\n→ Remettez le condensateur 10 µF entre RESET et GND.\n", "ok");
      setBadge("isp", "Mode programmateur");
      $("statusMsg").textContent = "ArduinoISP installé. Remettez le condensateur 10 µF, câblez l'ATtiny, puis « Vérifier le programmateur ».";
    } else {
      log("\n✔ L'Arduino est revenu en mode NORMAL.\n", "ok");
      setBadge("normal", "Mode normal");
      $("statusMsg").textContent = "L'Arduino est en mode normal : il peut recevoir n'importe quel programme.";
    }
  } catch (e) { reportError(e); }
  finally { setBusy(false); }
}

/* ------------------------------------------------------------ cible / brochage */
function onTargetChange() {
  const t = targetInfo(), sel = $("clock");
  const saved = store.get("clock." + $("target").value, t.default_clock);
  sel.innerHTML = "";
  Object.entries(t.clocks).forEach(([k, v]) => sel.add(new Option(v.label + (k === t.default_clock ? " (recommandé)" : ""), k)));
  sel.value = t.clocks[saved] ? saved : t.default_clock;
  store.set("target", $("target").value);
  drawPinout();
}
function drawPinout() {
  const name = targetInfo().name; $("chipName").textContent = "· " + name;
  const bx = 95, bw = 80, top = 12, step = 32;
  let s = `<rect x="${bx}" y="${top}" width="${bw}" height="${step * 4 + 4}" rx="6" fill="var(--chip)" stroke="var(--muted)"/>`;
  s += `<path d="M${bx + bw / 2 - 10} ${top} a10 10 0 0 0 20 0" fill="var(--panel)" stroke="var(--muted)"/>`;
  s += `<circle cx="${bx + 12}" cy="${top + 14}" r="3.5" fill="var(--muted)"/>`;
  s += `<text x="${bx + bw / 2}" y="${top + step * 2 + 6}" text-anchor="middle" font-size="11" fill="var(--text)" transform="rotate(-90 ${bx + bw / 2} ${top + step * 2 + 2})">${name}</text>`;
  for (let i = 0; i < 4; i++) {
    const y = top + 20 + i * step, j = 7 - i;
    s += `<rect x="${bx - 10}" y="${y - 5}" width="10" height="10" fill="var(--muted)"/>`;
    s += `<text x="${bx + 4}" y="${y + 4}" font-size="10" fill="var(--muted)">${i + 1}</text>`;
    s += `<text x="${bx - 14}" y="${y + 4}" font-size="10.5" text-anchor="end" fill="var(--text)">${PINS[i]}</text>`;
    s += `<rect x="${bx + bw}" y="${y - 5}" width="10" height="10" fill="var(--muted)"/>`;
    s += `<text x="${bx + bw - 4}" y="${y + 4}" font-size="10" text-anchor="end" fill="var(--muted)">${j + 1}</text>`;
    s += `<text x="${bx + bw + 14}" y="${y + 4}" font-size="10.5" fill="var(--text)">${PINS[j]}</text>`;
  }
  $("pinout").innerHTML = s;
}

/* ------------------------------------------------------------ démarrage */
async function init() {
  initEditor();
  const th = store.get("theme", null); if (th) document.documentElement.dataset.theme = th;
  try { INFO = await (await fetch("api/info")).json(); }
  catch (e) { log("Serveur de compilation injoignable.\n", "bad"); return; }
  if (!INFO.compiler) log("⚠ Compilateur indisponible sur ce serveur.\n", "bad");

  Object.entries(INFO.targets).forEach(([k, v]) => $("target").add(new Option(v.name, k)));
  Object.entries(INFO.boards).forEach(([k, v]) => $("board").add(new Option(v.name, k)));
  $("example").add(new Option("Exemples…", ""));
  Object.entries(EXAMPLES).forEach(([k, v]) => $("example").add(new Option(v.name, k)));
  $("target").value = INFO.targets[store.get("target", "attiny85")] ? store.get("target", "attiny85") : "attiny85";
  $("board").value = INFO.boards[store.get("board", "uno")] ? store.get("board", "uno") : "uno";
  onTargetChange();

  $("target").onchange = onTargetChange;
  $("clock").onchange = () => {
    store.set("clock." + $("target").value, $("clock").value);
    log("Horloge changée : cliquez sur « Graver les fusibles » pour l'appliquer à la puce.\n", "hint");
  };
  $("board").onchange = () => store.set("board", $("board").value);
  $("example").onchange = () => {
    const ex = EXAMPLES[$("example").value]; $("example").value = "";
    if (ex && confirm("Remplacer le code actuel par l'exemple « " + ex.name + " » ?")) editor.setValue(ex.code);
  };
  $("btnPort").onclick = choosePort; $("pmChoose").onclick = choosePort; $("pmClose").onclick = closeModal;
  $("btnCompile").onclick = compile; $("btnUpload").onclick = upload; $("btnFuses").onclick = burnFuses;
  $("btnIsp").onclick = () => flashBoard("isp"); $("btnNormal").onclick = () => flashBoard("normal");
  $("btnCheck").onclick = async () => { if (await needPort()) checkProgrammer(); };
  $("themeBtn").onclick = () => {
    const r = document.documentElement, dark = getComputedStyle(r).getPropertyValue("--bg").trim() === "#11151b";
    r.dataset.theme = dark ? "light" : "dark"; store.set("theme", r.dataset.theme);
  };
  document.addEventListener("keydown", e => {
    if (e.ctrlKey && e.key.toLowerCase() === "u") { e.preventDefault(); upload(); }
    if (e.ctrlKey && e.key.toLowerCase() === "r") { e.preventDefault(); compile(); }
    if (e.key === "Escape") closeModal();
  });

  log("Prêt. Choisissez le port de votre Arduino, écrivez le code puis Téléverser (Ctrl+U).\n");
  if (!("serial" in navigator)) { $("banner").classList.add("show"); return; }

  // Ports déjà autorisés lors d'une visite précédente
  const known = await navigator.serial.getPorts();
  if (known.length === 1) { setPort(known[0]); log("Port retrouvé : " + portLabel(known[0]) + "\n", "ok"); checkProgrammer(); }
  else openModal();

  navigator.serial.addEventListener("connect", e => {
    log("Module branché : " + portLabel(e.target) + "\n", "ok");
    if (!port) { setPort(e.target); checkProgrammer(); }
  });
  navigator.serial.addEventListener("disconnect", e => {
    if (e.target !== port) return;
    log("Module débranché.\n", "bad"); setPort(null);
    openModal("Module débranché", "Rebranchez l'Arduino puis choisissez de nouveau son port.");
  });
}
init();
