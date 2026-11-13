import { replay } from './core.js';
self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: replay(data) });
  } catch (e) {
    self.postMessage({ error: e.message });
  }
};
