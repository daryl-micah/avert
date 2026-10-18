import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://avert-agent.vercel.app',
  integrations: [
    starlight({
      title: 'Avert',
      description: 'Knows every external API your code calls, sees when a provider changes one, and traces what it breaks.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/daryl-micah/avert' }],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        { label: 'Start here', items: ['quickstart', 'connect', 'concepts', 'falkordb'] },
        { label: 'Guides', items: ['agents', 'contributing', 'limits'] },
        { label: 'Reference', items: ['reference/mcp-tools', 'reference/queries'] },
      ],
    }),
  ],
});
