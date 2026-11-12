"""Diagnostico do TDB Launcher (12/11/2026): junta num unico .zip tudo que e preciso para entender um problema (logs, versoes, estado do
save local, portas e processos), sem mandar nada sozinho: a pessoa so envia o arquivo gerado.

O que vai no zip: info.txt (resumo legivel), os logs do launcher, do servidor local (host), do banco local (Firestore), da ponte TLS e do
cliente (ultimos 3 MB de cada), a configuracao do launcher e o arquivo do save local (emu_data ...\\output-0: so dados do jogo, nenhuma
senha). Nao entra nada fora disso.
"""
from __future__ import annotations

import os
import platform
import re
import subprocess
import sys
import time
import zipfile
from pathlib import Path

LIMITE = 3 * 1024 * 1024
SEM_JANELA = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _cauda(p: Path, limite: int = LIMITE) -> bytes:
    try:
        tam = p.stat().st_size
        with open(p, "rb") as f:
            if tam > limite:
                f.seek(tam - limite)
                return b"[... inicio cortado: arquivo com %d bytes ...]\n" % tam + f.read()
            return f.read()
    except OSError:
        return b""


def _cmd(args, timeout: int = 25) -> str:
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, creationflags=SEM_JANELA, encoding="utf-8", errors="replace")
        return r.stdout
    except Exception as e:
        return "(falhou: %s)" % e


def _quando(p: Path) -> str:
    try:
        return time.strftime("%d/%m %H:%M:%S", time.localtime(p.stat().st_mtime))
    except OSError:
        return "?"


def _lista(pasta: Path, profundidade: int = 1, limite: int = 60) -> list:
    out = []
    try:
        for p in sorted(pasta.iterdir())[:limite]:
            out.append("  %s%s  %s  %s" % (p.name, "\\" if p.is_dir() else "", ("%d bytes" % p.stat().st_size) if p.is_file() else "", _quando(p)))
    except OSError as e:
        out.append("  (nao consegui listar: %s)" % e)
    return out


def _saves(emu: Path) -> list:
    """Resumo do save local: quais personagens existem no output-0 e que campos tem (sem copiar valores sensiveis)."""
    L = []
    for d in sorted(emu.glob("emu_data*")):
        f = d / "firestore_export" / "all_namespaces" / "all_kinds" / "output-0"
        if not f.exists():
            L.append("  %s: sem output-0" % d.name)
            continue
        b = f.read_bytes()
        L.append("  %s: output-0 %d bytes, %s" % (d.name, len(b), _quando(f)))
        if d.name != "emu_data":
            continue
        ids = sorted(set(re.findall(rb"7656119\d{10}", b)))
        L.append("    personagens (SteamId) encontrados: %s" % (", ".join(i.decode() for i in ids) or "NENHUM"))
        for sid in ids:
            j = b.find(sid)
            k = b.find(b'players"', j + 20)
            doc = b[j:k if k > 0 else len(b)]
            marcas = [m.decode() for m in (b"charlist", b"TutorialBegginer", b"TutorStage", b"PlayerPosition", b"Quests", b"Inventory", b"Stash") if m in doc]
            pos = re.search(rb"Translation: X=([-\d.]+) Y=([-\d.]+) Z=([-\d.]+)", doc)
            etapa = re.search(rb"TutorStage.{4,8}?([A-Za-z]{4,30})", doc, re.S)
            L.append("    %s: %d bytes | campos: %s | pos(m): %s | etapa: %s" % (
                sid.decode(), len(doc), ", ".join(marcas) or "-",
                ("%.0f, %.0f" % (float(pos.group(1)) / 100, float(pos.group(2)) / 100)) if pos else "-",
                etapa.group(1).decode("latin-1") if etapa else "-"))
    return L


def info_texto(raiz: Path, aqui: Path, cfg: dict) -> str:
    L = ["TDB Launcher - diagnostico gerado em %s" % time.strftime("%d/%m/%Y %H:%M:%S"), ""]
    try:
        L.append("launcher: %s" % (aqui / "versao.txt").read_text(encoding="utf-8").strip())
    except OSError:
        L.append("launcher: versao.txt ausente")
    L.append("projeto: %s" % raiz)
    L.append("Windows: %s | Python %s" % (platform.platform(), sys.version.split()[0]))
    py = Path(sys.executable)
    if py.name.lower() == "pythonw.exe" and (py.parent / "python.exe").exists():
        py = py.parent / "python.exe"
    v = _cmd([str(py), "-I", "-c", "import frida; print(frida.__version__)"], timeout=60).strip()
    L.append("frida: %s" % (v if re.fullmatch(r"[0-9.]+", v) else "NAO instalado neste Python (%s)" % v[-120:]))
    host_txt = raiz / "cliente" / "host.txt"
    L.append("host.txt: %s" % (host_txt.read_text(encoding="utf-8").strip() if host_txt.exists() else "(nao existe)"))
    pasta = cfg.get("pasta_jogo", "")
    L.append("pasta do jogo: %s" % (pasta or "(nao escolhida)"))
    exe = Path(pasta) / "Survival" / "Binaries" / "Win64" / "TheDayBefore.exe" if pasta else None
    L.append("TheDayBefore.exe: %s" % ("ok" if exe and exe.exists() else "NAO ENCONTRADO"))
    if pasta:
        L += ["", "Paks do jogo:"] + _lista(Path(pasta) / "Survival" / "Content" / "Paks")
    L += ["", "Arquivos de versao (host_otimizado): "]
    for rel in ("host_otimizado/servidor_host.py", "host_otimizado/scripts/carregar_dados.js", "host_otimizado/scripts/quest_fix.js", "cliente/cliente_conecta.py"):
        p = raiz / rel
        L.append("  %s: %s" % (rel, ("%d bytes, %s" % (p.stat().st_size, _quando(p))) if p.exists() else "AUSENTE"))
    emu = raiz / "servicos" / "firestore_emu"
    L += ["", "Pasta do banco local: %s (%s)" % (emu, "existe" if emu.exists() else "NAO EXISTE")]
    if emu.exists():
        L += _lista(emu, limite=40)
        L += ["", "Saves locais:"] + _saves(emu)
    cache = raiz / "servicos" / "appdata_host_7777" / "firestore" / "__FIRAPP_DEFAULT" / "the-day-before-8f438" / "main"
    L += ["", "Cache de leitura do servidor (%s):" % cache]
    if cache.exists():
        L += _lista(cache)
        try:
            L.append("  CURRENT = %s" % (cache / "CURRENT").read_text(errors="replace").strip())
        except OSError:
            L.append("  CURRENT ausente")
    else:
        L.append("  (nao existe)")
    L += ["", "Portas em uso (443, 8081, 7777, 9150, 4400, 4500):"]
    for linha in _cmd(["netstat", "-ano", "-p", "TCP"]).splitlines() + _cmd(["netstat", "-ano", "-p", "UDP"]).splitlines():
        if re.search(r":(443|8081|7777|9150|4400|4500)\s", linha) and ("LISTENING" in linha or "UDP" in linha):
            L.append("  " + linha.strip())
    L += ["", "Processos relevantes:"]
    for linha in _cmd(["tasklist", "/FO", "CSV", "/NH"]).splitlines():
        if re.search(r"TheDayBefore|java|node|python|frida", linha, re.I):
            L.append("  " + linha.strip()[:110])
    L += ["", "Memoria/Disco:"]
    try:
        import ctypes
        class _MS(ctypes.Structure):
            _fields_ = [("l", ctypes.c_ulong), ("uso", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("livre", ctypes.c_ulonglong),
                        ("a", ctypes.c_ulonglong), ("b", ctypes.c_ulonglong), ("c", ctypes.c_ulonglong), ("d", ctypes.c_ulonglong), ("e", ctypes.c_ulonglong)]
        ms = _MS(); ms.l = ctypes.sizeof(_MS); ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
        L.append("  RAM: %.1f GB total, %.1f GB livre" % (ms.total / 2**30, ms.livre / 2**30))
    except Exception as e:
        L.append("  RAM: (falhou: %s)" % e)
    try:
        import shutil
        du = shutil.disk_usage(str(raiz))
        L.append("  Disco do projeto: %.1f GB livres de %.1f GB" % (du.free / 2**30, du.total / 2**30))
    except Exception as e:
        L.append("  Disco: (falhou: %s)" % e)
    return "\n".join(L) + "\n"


def gerar(raiz: Path, aqui: Path, cfg: dict) -> Path:
    desktop = Path(os.path.expanduser("~")) / "Desktop"
    destino = desktop if desktop.is_dir() else aqui
    arq = destino / ("TDB_diagnostico_%s.zip" % time.strftime("%Y%m%d_%H%M%S"))
    tmp = Path(os.environ.get("TEMP", "."))
    fontes = [
        (aqui / "launcher.log", "launcher.log"), (aqui / "launcher.log.anterior", "launcher.log.anterior"),
        (aqui / "config.json", "launcher_config.json"),
        (tmp / "servidor_host_headless.out", "servidor_host_headless.out"), (tmp / "servidor_host_headless.out.anterior", "servidor_host_headless.out.anterior"),
        (tmp / "firestore_emu.err", "firestore_emu.err"), (tmp / "tls_front.err", "tls_front.err"), (tmp / "ipv6_bridge.err", "ipv6_bridge.err"),
        (raiz / "servicos" / "firestore_emu" / "firestore-debug.log", "firestore-debug.log"),
    ]
    fontes += [(p, p.name) for p in sorted((raiz / "cliente").glob("cliente_frida_*.log"))]
    with zipfile.ZipFile(arq, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("info.txt", info_texto(raiz, aqui, cfg))
        for p, nome in fontes:
            dados = _cauda(p)
            if dados:
                z.writestr(nome, dados)
        out0 = raiz / "servicos" / "firestore_emu" / "emu_data" / "firestore_export" / "all_namespaces" / "all_kinds" / "output-0"
        if out0.exists() and out0.stat().st_size < 20 * 1024 * 1024:
            z.write(out0, "save_local_output-0")
    return arq
