    // No placeholder of the template is left. The CHANGELOG section itself may
    // mention {{ template }} syntax, so only the template's own names count.
    expect(notes).not.toMatch(
      /\{\{\s*(?:version|anchor|repo|sha256|pre_commit|semgrep|gitleaks|changes|pull_requests)\s*\}\}/,
    );
