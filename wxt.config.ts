import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Open Media Downloader',
    description: 'Discover and download authorized, non-DRM web media.',
    permissions: ['declarativeNetRequestWithHostAccess', 'downloads', 'storage', 'tabs', 'webRequest'],
    host_permissions: ['http://*/*', 'https://*/*'],
    action: {
      default_title: 'Open Media Downloader',
    },
  },
});
