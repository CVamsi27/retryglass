// This pure synthetic adapter is loaded only inside the disposable worker image.
// Replace it with explicitly selected compiled processor modules, never an application boot file.
export { default } from '../dist/examples/invoice/corrected.js';
