module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    { name: 'core-boundary', severity: 'error', from: { path: '^core/' },
      to: { path: '^(adapters/|bin/|cli/|server\\.ts$)' } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'] },
  },
}
