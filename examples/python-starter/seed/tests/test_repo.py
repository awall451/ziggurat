from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_readme_tells_how_to_run_the_checks():
    text = (ROOT / "README.md").read_text()
    assert "pytest" in text and "ruff" in text
