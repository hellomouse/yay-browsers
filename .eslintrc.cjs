module.exports = {
  parserOptions: {
    project: 'tsconfig.json'
  },
  extends: [
    '@hellomouse/eslint-config-typescript'
  ],
  env: {
    node: true,
    es6: true
  },
  rules: {
    // js compatibility
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/naming-convention': 'off'
  },
  ignorePatterns: ['/.eslintrc.cjs']
};
