import babel from '@rollup/plugin-babel';
import terser from '@rollup/plugin-terser';

function configurePlugins(opts = {}) {
  const plugins = [];
  if (opts.isBrowser) {
    plugins.push(
      babel({
        babelHelpers: 'bundled',
        presets: [
          [
            '@babel/preset-env',
            {
              targets: {
                browsers: ['baseline widely available'],
              },
            },
          ],
        ],
      })
    );
  }
  if (opts.minify) {
    plugins.push(
      terser({
        module: true,
        mangle: true,
        compress: true,
      })
    );
  }
  return plugins;
}

export default [
  {
    input: 'dist/modules/declarative-partial-updates-polyfill.js',
    plugins: configurePlugins({isBrowser: true, minify: true}),
    output: {
      format: 'esm',
      file: './dist/declarative-partial-updates-polyfill.js',
    },
  },
  {
    input: 'dist/modules/declarative-partial-updates-polyfill.js',
    plugins: configurePlugins({isBrowser: false, minify: true}),
    output: {
      format: 'cjs',
      file: './dist/declarative-partial-updates-polyfill.cjs',
    },
  },
];
