# -*- coding: utf-8 -*-
"""
Programmateur ATtiny85 / ATtiny13 en ligne - serveur de compilation.

Le serveur compile le code avec arduino-cli et renvoie le fichier .hex.
Le televersement est fait par le NAVIGATEUR (Web Serial) : le serveur
n'a jamais acces a l'Arduino de l'utilisateur.

En local :   python server.py            -> http://127.0.0.1:8085
En ligne :   variables d'environnement PORT, HOST=0.0.0.0, SITE_URL=https://...
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
SKETCHES = os.path.join(HERE, "sketches")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8085"))
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")
MAX_CODE = 100_000            # taille max du code envoye (octets)
COMPILE_TIMEOUT = 180         # secondes
MAX_PARALLEL = int(os.environ.get("MAX_PARALLEL", "2"))
RATE_PER_MIN = int(os.environ.get("RATE_PER_MIN", "20"))

os.environ["ARDUINO_UPDATER_ENABLE_NOTIFICATION"] = "false"


def find_arduino_cli():
    env = os.environ.get("ARDUINO_CLI")
    if env and os.path.isfile(env):
        return env
    local = os.environ.get("LOCALAPPDATA", "")
    for c in (r"C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe",
              os.path.join(local, "Programs", "Arduino IDE", "resources", "app", "lib",
                           "backend", "resources", "arduino-cli.exe")):
        if os.path.isfile(c):
            return c
    return shutil.which("arduino-cli")


CLI = find_arduino_cli()

# ATTinyCore 1.x : sous Windows l'etape facultative de listing (.lst) plante si le
# chemin contient un espace. On la desactive (sans effet sous Linux).
ATTINYCORE_FIX = [
    "--build-property", "recipe.hooks.objcopy.postobjcopy.1.pattern.windows=",
    "--build-property", "recipe.hooks.savehex.presavehex.2.pattern.windows=",
]

# Fusibles releves dans les boards.txt de ATTinyCore et MicroCore.
TARGETS = {
    "attiny85": {
        "name": "ATtiny85", "signature": [0x1E, 0x93, 0x0B],
        "fqbn": "ATTinyCore:avr:attinyx5:chip=85,clock={clock}", "extra": ATTINYCORE_FIX,
        "flash": 8192, "page": 64, "eeprom": 512,
        "default_clock": "8internal",
        "clocks": {
            "8internal": {"label": "8 MHz interne", "fuses": {"lfuse": 0xE2, "hfuse": 0xD7, "efuse": 0xFF}},
            "1internal": {"label": "1 MHz interne", "fuses": {"lfuse": 0x62, "hfuse": 0xD7, "efuse": 0xFF}},
            "16pll": {"label": "16 MHz (PLL interne)", "fuses": {"lfuse": 0xF1, "hfuse": 0xD7, "efuse": 0xFF}},
        },
    },
    "attiny13": {
        "name": "ATtiny13", "signature": [0x1E, 0x90, 0x07],
        "fqbn": "MicroCore:avr:13:clock={clock}", "extra": [],
        "flash": 1024, "page": 32, "eeprom": 64,
        "default_clock": "9M6",
        "clocks": {
            "9M6": {"label": "9.6 MHz interne", "fuses": {"lfuse": 0x3A, "hfuse": 0xFB}},
            "4M8": {"label": "4.8 MHz interne", "fuses": {"lfuse": 0x39, "hfuse": 0xFB}},
            "1M2": {"label": "1.2 MHz interne", "fuses": {"lfuse": 0x2A, "hfuse": 0xFB}},
        },
    },
}

# Cartes utilisables comme programmateur (bootloader STK500v1)
BOARDS = {
    "uno": {"name": "Arduino Uno", "fqbn": "arduino:avr:uno", "baud": 115200, "page": 128},
    "nano": {"name": "Arduino Nano", "fqbn": "arduino:avr:nano:cpu=atmega328", "baud": 115200, "page": 128},
    "nano_old": {"name": "Arduino Nano (ancien bootloader)", "fqbn": "arduino:avr:nano:cpu=atmega328old",
                 "baud": 57600, "page": 128},
}
FIRMWARES = {"isp": "ArduinoISP", "normal": "ModeNormal"}

SEM = threading.BoundedSemaphore(MAX_PARALLEL)
FW_LOCK = threading.Lock()
FW_CACHE = {}
RATE = {}
RATE_LOCK = threading.Lock()


def rate_ok(ip):
    now = time.time()
    with RATE_LOCK:
        hits = [t for t in RATE.get(ip, []) if now - t < 60]
        if len(hits) >= RATE_PER_MIN:
            RATE[ip] = hits
            return False
        hits.append(now)
        RATE[ip] = hits
        if len(RATE) > 5000:
            RATE.clear()
    return True


def hints_for(out):
    o = out.lower()
    h = []
    if re.search(r"sketch\.ino:\d+", out) and ("error" in o or "erreur" in o):
        h.append("Erreur dans votre code : les lignes concernees sont surlignees dans l'editeur.")
    if "too big" in o or "trop gros" in o:
        h.append("Le programme est trop gros pour la memoire de la puce.")
    if "no such file" in o and ".h" in o:
        h.append("Bibliotheque introuvable : seules les bibliotheques integrees au core sont disponibles.")
    return h


def compile_sketch(fqbn, extra, sketch_src_dir=None, code=None):
    """Compile et renvoie (ok, hex_text, log)."""
    tmp = tempfile.mkdtemp(prefix="attiny_")
    try:
        sk = os.path.join(tmp, "sketch")
        if sketch_src_dir:
            shutil.copytree(sketch_src_dir, sk)
            name = os.path.basename(sketch_src_dir)
            os.rename(os.path.join(sk, name + ".ino"), os.path.join(sk, "sketch.ino"))
        else:
            os.makedirs(sk)
            with open(os.path.join(sk, "sketch.ino"), "w", encoding="utf-8", newline="\n") as f:
                f.write(code)
        out_dir = os.path.join(tmp, "out")
        args = [CLI, "compile", "--fqbn", fqbn, "--build-path", out_dir] + extra + [sk]
        try:
            r = subprocess.run(args, capture_output=True, timeout=COMPILE_TIMEOUT, stdin=subprocess.DEVNULL,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            log = (r.stdout + r.stderr).decode("utf-8", "replace")
            ok = r.returncode == 0
        except subprocess.TimeoutExpired:
            return False, None, "Compilation trop longue (delai depasse)."
        # On masque les chemins du serveur dans le journal
        log = log.replace(sk + os.sep, "").replace(sk, "sketch").replace(tmp, "")
        hexf = os.path.join(out_dir, "sketch.ino.hex")
        hex_text = None
        if ok and os.path.isfile(hexf):
            with open(hexf, "r", encoding="ascii") as f:
                hex_text = f.read()
        return ok and hex_text is not None, hex_text, log
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def get_firmware(board, kind):
    key = (board, kind)
    with FW_LOCK:
        if key in FW_CACHE:
            return FW_CACHE[key]
        ok, hx, log = compile_sketch(BOARDS[board]["fqbn"], [], os.path.join(SKETCHES, FIRMWARES[kind]))
        res = {"ok": ok, "hex": hx, "log": log}
        if ok:
            FW_CACHE[key] = res
        return res


def public_targets():
    return {k: {kk: v[kk] for kk in ("name", "signature", "flash", "page", "eeprom", "default_clock", "clocks")}
            for k, v in TARGETS.items()}


def public_boards():
    return {k: {"name": v["name"], "baud": v["baud"], "page": v["page"]} for k, v in BOARDS.items()}


MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
        ".webmanifest": "application/manifest+json", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ProgATtiny/2.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For", "")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def send_bytes(self, data, ctype, code=200, cache="no-cache"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, code=200):
        self.send_bytes(json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8", code)

    def base_url(self):
        if SITE_URL:
            return SITE_URL
        proto = self.headers.get("X-Forwarded-Proto", "http")
        return "%s://%s" % (proto, self.headers.get("Host", "%s:%d" % (HOST, PORT)))

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/info":
            return self.send_json({"compiler": bool(CLI), "targets": public_targets(), "boards": public_boards()})
        if path == "/robots.txt":
            txt = "User-agent: *\nAllow: /\nSitemap: %s/sitemap.xml\n" % self.base_url()
            return self.send_bytes(txt.encode(), MIME[".txt"])
        if path == "/sitemap.xml":
            xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                   '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                   '  <url><loc>%s/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>\n'
                   '</urlset>\n') % self.base_url()
            return self.send_bytes(xml.encode(), MIME[".xml"])
        if path in ("/", ""):
            path = "/index.html"
        # Fichiers statiques du dossier web/
        rel = os.path.normpath(path.lstrip("/"))
        full = os.path.join(WEB, rel)
        if rel.startswith("..") or not os.path.abspath(full).startswith(os.path.abspath(WEB) + os.sep) \
                or not os.path.isfile(full):
            return self.send_json({"error": "introuvable"}, 404)
        with open(full, "rb") as f:
            data = f.read()
        if rel == "index.html":
            data = data.replace(b"%%SITE_URL%%", self.base_url().encode())
        ext = os.path.splitext(full)[1].lower()
        self.send_bytes(data, MIME.get(ext, "application/octet-stream"),
                        cache="no-cache" if ext == ".html" else "public, max-age=3600")

    # ------------------------------------------------------------------ POST
    def do_POST(self):
        path = urlparse(self.path).path
        if not CLI:
            return self.send_json({"ok": False, "error": "Compilateur indisponible sur ce serveur."}, 503)
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n > MAX_CODE + 10_000:
                return self.send_json({"ok": False, "error": "Code trop long."}, 413)
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return self.send_json({"ok": False, "error": "Requete invalide."}, 400)
        if not rate_ok(self.client_ip()):
            return self.send_json({"ok": False, "error": "Trop de compilations, patientez une minute."}, 429)

        if path == "/api/compile":
            t = TARGETS.get(body.get("target"))
            clock = body.get("clock")
            code = body.get("code")
            if not t or clock not in t["clocks"] or not isinstance(code, str) or len(code) > MAX_CODE:
                return self.send_json({"ok": False, "error": "Parametres invalides."}, 400)
            if not SEM.acquire(timeout=60):
                return self.send_json({"ok": False, "error": "Serveur occupe, reessayez."}, 503)
            try:
                t0 = time.time()
                ok, hx, log = compile_sketch(t["fqbn"].format(clock=clock), t["extra"], code=code)
            finally:
                SEM.release()
            errors = [{"line": int(m.group(1)), "msg": m.group(3).strip()}
                      for m in re.finditer(r"sketch\.ino:(\d+):(?:\d+:)?\s*(error|erreur)\s*:?\s*(.*)", log, re.I)]
            return self.send_json({"ok": ok, "hex": hx, "log": log, "errors": errors,
                                   "hints": [] if ok else hints_for(log), "seconds": round(time.time() - t0, 1)})

        if path == "/api/firmware":
            board, kind = body.get("board"), body.get("kind")
            if board not in BOARDS or kind not in FIRMWARES:
                return self.send_json({"ok": False, "error": "Parametres invalides."}, 400)
            if not SEM.acquire(timeout=120):
                return self.send_json({"ok": False, "error": "Serveur occupe, reessayez."}, 503)
            try:
                res = get_firmware(board, kind)
            finally:
                SEM.release()
            return self.send_json(res)

        self.send_json({"error": "introuvable"}, 404)


def main():
    print("arduino-cli :", CLI or "INTROUVABLE", flush=True)
    if "--warm" in sys.argv:   # precompile cores et firmwares (construction Docker)
        for b in BOARDS:
            for k in FIRMWARES:
                print(b, k, get_firmware(b, k)["ok"], flush=True)
        for key, t in TARGETS.items():
            with open(os.path.join(SKETCHES, "ModeNormal", "ModeNormal.ino"), encoding="utf-8") as f:
                ok, _, log = compile_sketch(t["fqbn"].format(clock=t["default_clock"]), t["extra"], code=f.read())
            print(key, ok, flush=True)
            if not ok:
                print(log)
                sys.exit(1)
        return
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    url = "http://%s:%d" % ("127.0.0.1" if HOST == "0.0.0.0" else HOST, PORT)
    print("Programmateur ATtiny : %s" % url, flush=True)
    if "--no-browser" not in sys.argv and HOST == "127.0.0.1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
