/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // @argus/shared ships as TypeScript-built ESM in the workspace; Next has to
  // be told to run it through its own pipeline.
  transpilePackages: ["@argus/shared"],
};
