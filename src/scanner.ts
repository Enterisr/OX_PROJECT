import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import ts from 'typescript';
import type { Finding, RepositorySnapshot, Scanner, Severity } from './domain.js';

export class MockScanner implements Scanner {
  async scan(_repository: RepositorySnapshot, onProgress: Parameters<Scanner['scan']>[1]) {
    await onProgress(65, 'Preparing demo findings');
    await setTimeout(400);
    await onProgress(75, 'Loading demo findings');
    await setTimeout(400);
    return [
      {
        id: randomUUID(), severity: 'high' as const,
        title: 'Demo: SQL query built from user input',
        description: 'Synthetic example of input inserted into a SQL query without parameters. This file has not been inspected.',
        filePath: 'demo/routes/search.ts', line: 24,
      },
      {
        id: randomUUID(), severity: 'medium' as const,
        title: 'Demo: dependency vulnerability',
        description: 'Synthetic dependency finding. No package, version, or vulnerability database has been checked.',
        filePath: 'demo/package.json', line: 12,
      },
      {
        id: randomUUID(), severity: 'low' as const,
        title: 'Demo: verbose error response',
        description: 'Synthetic example of internal error details returned to a client. This file has not been inspected.',
        filePath: 'demo/middleware/errors.ts', line: 9,
      },
    ];
  }
}

export class BasicScanner implements Scanner {
  async scan(repository: RepositorySnapshot, onProgress: Parameters<Scanner['scan']>[1]): Promise<Finding[]> {
    const findings: Finding[] = [];
    const files = repository.files.filter(({ path }) => /\.[cm]?[jt]sx?$/i.test(path) && !/(^|\/)(node_modules|dist|build|vendor)\//.test(path));
    await onProgress(60, 'Checking JavaScript and TypeScript source');
    for (const [index, file] of files.entries()) {
      const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
      const add = (node: ts.Node, ruleId: string, severity: Severity, title: string, description: string) => {
        findings.push({ id: randomUUID(), ruleId, severity, title, description, filePath: file.path,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
      };
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const name = ts.isIdentifier(node.expression) ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
          if (name === 'eval') add(node, 'dynamic-eval', 'high', 'Dynamic code evaluation',
            'An eval call was found. If its argument contains untrusted input, it can execute attacker-controlled JavaScript.');
          if (name === 'exec' || name === 'execSync') {
            const command = node.arguments[0];
            let requestInput = false;
            const inspect = (child: ts.Node) => {
              if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression)
                && /^(req|request)$/.test(child.expression.text) && /^(body|query|params)$/.test(child.name.text)) requestInput = true;
              ts.forEachChild(child, inspect);
            };
            if (command) inspect(command);
            if (requestInput) add(node, 'request-shell', 'high', 'Request input passed to a shell command',
              'An exec/execSync command directly references request input. Shell metacharacters may allow unintended commands if this is a shell execution API.');
          }
        }
        if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/['"]/g, '') === 'rejectUnauthorized'
          && node.initializer.kind === ts.SyntaxKind.FalseKeyword) add(node, 'tls-verification', 'medium', 'TLS certificate verification disabled',
            'rejectUnauthorized is set to false. When used as a TLS option, this permits connections to servers with untrusted certificates.');
        ts.forEachChild(node, visit);
      };
      visit(source);
      await onProgress(60 + Math.floor(((index + 1) / files.length) * 20), `Checked ${index + 1}/${files.length} source files`);
    }
    return findings;
  }
}
