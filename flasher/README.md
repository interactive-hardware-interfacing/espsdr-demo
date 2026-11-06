# flasher/ — CircuitPython flashing for this demo

A self-contained component that puts a CircuitPython `.bin` onto an ESP32
family board from the browser over Web Serial. It is **licensed separately
from the rest of this repository, under the Apache License 2.0** (`LICENSE`,
`NOTICE`), because it bundles Espressif's esptool-js, which is Apache-2.0 and
is easier to audit when it sits apart from the GPL-3.0 page. The page loads it as an ES
module; nothing in here depends on anything outside this directory.

It is a copy of the same component in
[fox-bench](https://github.com/LC-Linkous/fox-bench); each repository keeps
its own so that it stands alone.

| | |
|---|---|
| `flasher.js` | the API: `setImage()`, `flash()`, `parseBinName()`, `demoEsptool()` |
| `md5.js` | MD5 for esptool-js's image verification |
| `vendor/esptool-js/` | the upstream bundle, unmodified, with its licence and version |

## API

```js
import * as flasher from './flasher/flasher.js';
flasher.setImage(fileName, uint8array);              // the image to write
const facts = await flasher.flash({
  offset: 0x0, eraseAll: true, baud: 460800,
  onPhase: text => {}, onProgress: fraction => {}, onLog: line => {},
});
// facts: { chip, revision, features, crystal, mac, flash_size, erase_ok, flash_ok, seconds }
```

`flash()` asks the browser for a port, connects with esptool-js, runs the
stub, optionally erases the whole flash, writes the image at `offset` with
MD5 verification, hard-resets, and closes the port. Errors carry the facts
gathered so far in `e.facts`. `demoEsptool()` returns a simulated esptool
with the same surface so the flow can run without hardware.

## Updating esptool-js

```
npm pack esptool-js@<version>
tar xzf esptool-js-<version>.tgz
cp package/bundle.js vendor/esptool-js/bundle.js
cp package/LICENSE  vendor/esptool-js/LICENSE
echo <version> > vendor/esptool-js/VERSION
```

and update `ESPTOOL_VERSION` in `flasher.js` to match.
