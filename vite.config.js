import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Contourne un plantage de la surveillance de fichiers dans un dossier
    // synchronisé par OneDrive (courant sur les PC "région").
    watch: {
      usePolling: true,
    },

    // Autorise l'accès au serveur de dev depuis une URL ngrok (pour jouer
    // avec des amis qui ne sont pas sur le même réseau). Le point au début
    // couvre tous les sous-domaines ngrok, qui changent à chaque redémarrage
    // du tunnel côté gratuit.
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io'],

    // Redirige les requêtes Socket.io vers le serveur temps réel qui tourne
    // sur le port 3001 (mini-warzone-server/). Comme ça, une seule URL/un
    // seul tunnel suffit côté client — pas besoin d'exposer le port 3001
    // séparément.
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
});
