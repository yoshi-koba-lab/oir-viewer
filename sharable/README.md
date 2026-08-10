# sharable/

Documents and working files that are safe to publish, and that are not part of
the product itself — review write-ups, notes meant for someone else to read,
figures prepared for sharing.

Anything here **is** pushed to the public repository. If a file names real
experiment folders, drive paths, unpublished data, or how the researcher works,
it belongs in `../non-sharable/` instead.

The product's own code and documentation stay where they are — `backend/`,
`frontend/`, `desktop/`, `scripts/`, `README.md`, `LICENSE`. Moving them here
would break CI, the PyInstaller spec and the Electron build for no gain; the
split exists to make the *publish / do-not-publish* decision explicit for
everything else.

If you are unsure which side a file belongs on, put it in `../non-sharable/`.
See [../AGENTS.md](../AGENTS.md).
