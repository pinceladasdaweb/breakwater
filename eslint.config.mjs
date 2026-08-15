import neostandard from 'neostandard'

export default neostandard({
  ts: true,
  // Build output and the two directories a mutation run leaves behind: an
  // interrupted `npm run test:mutation` drops a full project copy in
  // .stryker-tmp, and linting it buries the real errors in thousands.
  ignores: ['dist', 'reports', '.stryker-tmp']
})
