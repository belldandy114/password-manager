/// <reference types="vite/client" />

// Electron webview type declarations for React JSX
import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & {
        src?: string;
        preload?: string;
        allowpopups?: string;
        nodeintegration?: string;
        style?: React.CSSProperties;
      }, HTMLElement>;
    }
  }
}
