declare module 'tree-sitter-typescript' {
  import type Parser from 'tree-sitter';

  const languages: {
    typescript: Parser.Language;
    tsx: Parser.Language;
  };

  export = languages;
}
