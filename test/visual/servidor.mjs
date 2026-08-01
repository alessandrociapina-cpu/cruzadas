/* Servidor estático para abrir o aplicativo durante o desenvolvimento. */
import { serve } from './detect-photo.mjs';

const { port } = await serve();
console.log(`Cruzadas em http://127.0.0.1:${port}/  (Ctrl+C para parar)`);
