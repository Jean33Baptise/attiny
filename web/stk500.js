/*
 * Programmateur STK500v1 en JavaScript (Web Serial).
 *  - IspProgrammer : parle a ArduinoISP (19200 bauds) pour programmer un ATtiny.
 *  - BootloaderUploader : parle au bootloader Optiboot / ATmegaBOOT d'un Uno ou Nano
 *    pour installer ArduinoISP ou revenir en mode normal.
 * Licence MIT.
 */
(function () {
"use strict";

const STK = { OK: 0x10, INSYNC: 0x14, EOP: 0x20, NOSYNC: 0x15 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

class StkError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

/* ------------------------------------------------------------ fichier .hex */
function parseIntelHex(text) {
  const chunks = []; let base = 0, max = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ":") throw new Error("Fichier HEX invalide");
    const b = [];
    for (let i = 1; i < line.length; i += 2) b.push(parseInt(line.substr(i, 2), 16));
    const len = b[0], addr = (b[1] << 8) | b[2], type = b[3];
    let sum = 0; for (const x of b) sum = (sum + x) & 0xff;
    if (sum !== 0) throw new Error("Somme de controle HEX invalide");
    if (type === 0) {
      const a = base + addr; chunks.push([a, b.slice(4, 4 + len)]); max = Math.max(max, a + len);
    } else if (type === 1) break;
    else if (type === 2) base = ((b[4] << 8) | b[5]) << 4;
    else if (type === 4) base = ((b[4] << 8) | b[5]) << 16;
  }
  const data = new Uint8Array(max).fill(0xff);
  for (const [a, d] of chunks) data.set(d, a);
  return data;
}

/* ------------------------------------------------------------ port serie */
class SerialLink {
  constructor(port, log) { this.port = port; this.log = log || (() => {}); this.buf = []; this.waiters = []; }

  async open(baudRate) {
    await this.port.open({ baudRate, bufferSize: 4096 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.closed = false;
    this.loop = (async () => {
      try {
        while (!this.closed) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) { for (const x of value) this.buf.push(x); this._wake(); }
        }
      } catch (e) { /* port ferme ou debranche */ }
    })();
  }

  _wake() { const w = this.waiters; this.waiters = []; w.forEach(f => f()); }

  flush() { this.buf = []; }

  async write(bytes) { await this.writer.write(new Uint8Array(bytes)); }

  async read(n, timeout = 1000) {
    const end = Date.now() + timeout;
    while (this.buf.length < n) {
      const left = end - Date.now();
      if (left <= 0) throw new StkError("timeout", "Pas de reponse");
      await new Promise(res => { const t = setTimeout(res, left); this.waiters.push(() => { clearTimeout(t); res(); }); });
    }
    return this.buf.splice(0, n);
  }

  async signals(dtr) {
    await this.port.setSignals({ dataTerminalReady: dtr, requestToSend: dtr });
  }

  async close() {
    this.closed = true;
    try { await this.reader.cancel(); } catch (e) {}
    try { this.reader.releaseLock(); } catch (e) {}
    try { await this.loop; } catch (e) {}
    try { this.writer.releaseLock(); } catch (e) {}
    try { await this.port.close(); } catch (e) {}
  }
}

/* ------------------------------------------------------------ STK500v1 commun */
class Stk500 {
  constructor(link, log) { this.link = link; this.log = log || (() => {}); }

  async cmd(bytes, respLen = 0, timeout = 1000) {
    await this.link.write([...bytes, STK.EOP]);
    const [s] = await this.link.read(1, timeout);
    if (s === STK.NOSYNC) throw new StkError("nosync", "Desynchronise");
    if (s !== STK.INSYNC) throw new StkError("proto", "Reponse inattendue 0x" + s.toString(16));
    const data = respLen ? await this.link.read(respLen, timeout) : [];
    const [ok] = await this.link.read(1, timeout);
    if (ok !== STK.OK) throw new StkError("proto", "Commande refusee (0x" + ok.toString(16) + ")");
    return data;
  }

  async sync(tries = 10, timeout = 250) {
    for (let i = 0; i < tries; i++) {
      this.link.flush();
      await this.link.write([0x30, STK.EOP]);
      try {
        const r = await this.link.read(2, timeout);
        if (r[0] === STK.INSYNC && r[1] === STK.OK) {
          // une 2e synchro pour vider d'eventuels octets parasites
          await sleep(20); this.link.flush();
          await this.link.write([0x30, STK.EOP]);
          const r2 = await this.link.read(2, timeout);
          if (r2[0] === STK.INSYNC && r2[1] === STK.OK) return true;
        }
      } catch (e) { /* on reessaie */ }
    }
    return false;
  }

  async loadAddress(wordAddr) { await this.cmd([0x55, wordAddr & 0xff, (wordAddr >> 8) & 0xff]); }

  async writePage(bytes) {
    await this.cmd([0x64, (bytes.length >> 8) & 0xff, bytes.length & 0xff, 0x46, ...bytes], 0, 3000);
  }

  async readPage(len) { return this.cmd([0x74, (len >> 8) & 0xff, len & 0xff, 0x46], len, 3000); }

  async writeFlash(data, pageSize, progress) {
    const pages = Math.ceil(data.length / pageSize);
    for (let p = 0; p < pages; p++) {
      const addr = p * pageSize;
      const page = Array.from(data.slice(addr, addr + pageSize));
      while (page.length < pageSize) page.push(0xff);
      await this.loadAddress(addr >> 1);
      await this.writePage(page);
      progress && progress("Ecriture", (p + 1) / pages);
    }
  }

  async verifyFlash(data, pageSize, progress) {
    const pages = Math.ceil(data.length / pageSize);
    for (let p = 0; p < pages; p++) {
      const addr = p * pageSize;
      const len = Math.min(pageSize, data.length - addr);
      await this.loadAddress(addr >> 1);
      const got = await this.readPage(len);
      for (let i = 0; i < len; i++) {
        if (got[i] !== data[addr + i]) {
          throw new StkError("verify", `Verification echouee a l'adresse 0x${(addr + i).toString(16)} ` +
            `(lu 0x${got[i].toString(16)}, attendu 0x${data[addr + i].toString(16)})`);
        }
      }
      progress && progress("Verification", (p + 1) / pages);
    }
  }
}

/* ------------------------------------------------------------ ArduinoISP -> ATtiny */
class IspProgrammer extends Stk500 {
  /** Se connecte a ArduinoISP. Renvoie false si l'Arduino ne repond pas en programmateur. */
  async connect() {
    // A l'ouverture, l'Arduino peut redemarrer (pas de condensateur) : bootloader ~1,5 s puis ArduinoISP.
    await sleep(200);
    return this.sync(14, 300);
  }

  async setDevice(t) {
    const p = [0x42,
      0x86, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x03,
      0xff, 0xff, 0xff, 0xff,
      (t.page >> 8) & 0xff, t.page & 0xff,
      (t.eeprom >> 8) & 0xff, t.eeprom & 0xff,
      (t.flash >> 24) & 0xff, (t.flash >> 16) & 0xff, (t.flash >> 8) & 0xff, t.flash & 0xff];
    await this.cmd(p);
    await this.cmd([0x45, 0x05, 0x04, 0xd7, 0xc2, 0x00]);
  }

  async enter() { await this.cmd([0x50], 0, 2000); }
  async leave() { try { await this.cmd([0x51]); } catch (e) {} }
  async universal(a, b, c, d) { const [r] = await this.cmd([0x56, a, b, c, d], 1); return r; }

  async signature() {
    const s = [];
    for (let i = 0; i < 3; i++) s.push(await this.universal(0x30, 0x00, i, 0x00));
    return s;
  }

  async chipErase() {
    await this.universal(0xac, 0x80, 0x00, 0x00);
    await sleep(60);
    await this.leave(); await this.enter();
  }

  async readFuses() {
    return {
      lfuse: await this.universal(0x50, 0x00, 0x00, 0x00),
      hfuse: await this.universal(0x58, 0x08, 0x00, 0x00),
      efuse: await this.universal(0x50, 0x08, 0x00, 0x00),
    };
  }

  async writeFuses(f) {
    if (f.efuse !== undefined) { await this.universal(0xac, 0xa4, 0x00, f.efuse); await sleep(30); }
    await this.universal(0xac, 0xa8, 0x00, f.hfuse); await sleep(30);
    await this.universal(0xac, 0xa0, 0x00, f.lfuse); await sleep(30);
  }
}

/* ------------------------------------------------------------ bootloader Uno / Nano */
class BootloaderUploader extends Stk500 {
  async resetAndSync() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.link.signals(false); await sleep(120);
      await this.link.signals(true); await sleep(60);
      this.link.flush();
      if (await this.sync(12, 120)) return true;
    }
    return false;
  }
  async enter() {
    // Optiboot ignore les parametres mais repond ; ATmegaBOOT aussi.
    try { await this.cmd([0x42, ...new Array(20).fill(0)]); } catch (e) {}
    try { await this.cmd([0x45, 0, 0, 0, 0, 0]); } catch (e) {}
    await this.cmd([0x50]);
  }
  async leave() { try { await this.cmd([0x51]); } catch (e) {} }
}

window.STK500 = { parseIntelHex, SerialLink, IspProgrammer, BootloaderUploader, StkError, sleep };
})();
