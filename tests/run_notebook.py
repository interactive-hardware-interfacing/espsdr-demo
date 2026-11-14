"""Run notebooks/analyze_log.ipynb against a log zip and fail on any cell error.

    python tests/run_notebook.py notebooks/analyze_log.ipynb /tmp/fixture.zip
"""
import sys
import nbformat
from nbclient import NotebookClient

nb = nbformat.read(sys.argv[1], as_version=4)
assert nb.cells[1].source.startswith('ZIP ='), 'the second cell should set ZIP'
nb.cells[1].source = f'ZIP = {sys.argv[2]!r}'
NotebookClient(nb, timeout=180, kernel_name='python3').execute()   # raises on a cell error
text = '\n'.join(o.get('text', '') for c in nb.cells if c.cell_type == 'code' for o in c.get('outputs', []) if o.output_type == 'stream')
figures = sum(o.output_type == 'display_data' for c in nb.cells for o in c.get('outputs', []))
for must in ['busiest of 1/6/11: 6', '1 m -> 3 m: measured']:
    assert must in text, f'expected "{must}" in the notebook output'
print(f'notebook ok: {figures} figures')
print('\n'.join(l for l in text.splitlines() if '->' in l or 'busiest' in l))
