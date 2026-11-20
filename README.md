# TypeBeatToVideo for Cloudflare Pages

1. Extract the ZIP and commit its contents to the root of a GitHub repository.
2. Create a Cloudflare Pages project using Git integration and select that repository.
3. Select your production branch and the None framework preset.
4. Leave the build command blank and set the build output directory to public.
5. Deploy. The public directory already contains the built website.

Open the deployed HTTPS site to use the app. Video and animated GIF rendering load the FFmpeg WebAssembly engine as needed. Media processing runs in the browser.
