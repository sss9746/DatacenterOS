import { createRoot } from 'react-dom/client';
// Global tokens/base first so component stylesheets (imported by the components) can override at equal specificity.
import './styles.css';
import { App } from './app/App';
createRoot(document.getElementById('root')!).render(<App />);
