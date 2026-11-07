import ast
import json
import os
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
RUNNERS = (ROOT / "servidor_host.py", ROOT / "host" / "servidor_host.py")


def assignment(node, name):
    return isinstance(node, ast.Assign) and any(
        isinstance(target, ast.Name) and target.id == name for target in node.targets
    )


def configuration(runner):
    tree = ast.parse(runner.read_text(encoding="utf-8"), filename=str(runner))
    end = next(i for i, node in enumerate(tree.body) if assignment(node, "fh"))
    scope = {"__file__": str(runner), "__name__": "__main__"}
    with patch.dict(sys.modules, {"frida": Mock()}), patch.object(sys, "argv", [str(runner)]):
        exec(compile(ast.Module(tree.body[:end], []), str(runner), "exec"), scope)
    return tree, scope


def registration(runner):
    tree, scope = configuration(runner)
    nodes = [
        node for node in tree.body
        if assignment(node, "LISTA_URL")
        or isinstance(node, ast.FunctionDef) and node.name == "criar_servidor_na_lista"
    ]
    exec(compile(ast.Module(nodes, []), str(runner), "exec"), scope)
    return scope


def services(runner, missing=(), registration_error=None):
    tree, scope = configuration(runner)
    start = next(
        i for i, node in enumerate(tree.body)
        if isinstance(node, ast.If) and isinstance(node.test, ast.UnaryOp)
        and isinstance(node.test.operand, ast.Call)
        and isinstance(node.test.operand.func, ast.Name)
        and node.test.operand.func.id == "escutando_tcp"
    )
    end = next(i for i, node in enumerate(tree.body) if assignment(node, "out"))
    scope.update(
        TLS=os.path.join(scope["SERVICOS"], "tls"), log=Mock(), iniciar=Mock(),
        escutando_tcp=lambda port, address: (port, address) not in missing,
        esperar=lambda condition, seconds, name: condition(),
        criar_servidor_na_lista=Mock(side_effect=registration_error),
    )
    exec(compile(ast.Module(tree.body[start:end], []), str(runner), "exec"), scope)
    return scope


class ServerListTests(unittest.TestCase):
    def test_both_runners_use_workspace_services(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                _, scope = configuration(runner)
                self.assertEqual(Path(scope["SERVICOS"]), ROOT / "servicos")
                self.assertTrue((Path(scope["EMU"]) / "firebase.json").is_file())

    def test_registration_matches_browser_collection(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                scope = registration(runner)
                with patch("urllib.request.urlopen") as request:
                    scope["criar_servidor_na_lista"]()
                req = request.call_args.args[0]
                self.assertEqual(req.method, "PATCH")
                self.assertTrue(req.full_url.endswith(
                    "/server-list/us-central/versions/3/servers/127.0.0.1:7777"
                ))
                fields = json.loads(req.data)["fields"]
                self.assertEqual(fields["ServerName"], {"stringValue": "SERVIDOR-LOCAL"})
                self.assertEqual(fields["Adress"], {"stringValue": "127.0.0.1"})
                self.assertEqual(fields["Port"], {"integerValue": "7777"})

    def test_healthy_services_register_server(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                scope = services(runner)
                scope["criar_servidor_na_lista"].assert_called_once_with()
                scope["iniciar"].assert_not_called()

    def test_missing_service_aborts_startup(self):
        for runner in RUNNERS:
            for endpoint in ((8081, "127.0.0.1"), (8081, "::1"), (443, "127.0.0.1"), (443, "::1")):
                with self.subTest(runner=runner, endpoint=endpoint):
                    with self.assertRaises(SystemExit) as failure:
                        services(runner, missing=(endpoint,))
                    self.assertEqual(failure.exception.code, 1)

    def test_registration_failure_aborts_startup(self):
        for runner in RUNNERS:
            with self.subTest(runner=runner):
                with self.assertRaises(SystemExit) as failure:
                    services(runner, registration_error=urllib.error.URLError("emulator unavailable"))
                self.assertEqual(failure.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
