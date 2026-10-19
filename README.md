# OX Interview - POC Security Scanner

## Main Features

The app asynchronously scans a GitHub repository. Each scan is saved in a Neon PostgreSQL database and can have one or more reports.

The scanner currently checks a predefined set of common problems in Node.js applications and uses OSV to check dependencies in the lockfile.

Each component—ReportBuilder, Scanner, RepositoryReader, and others, impls an interface, allowing different implementations to be swapped in easily once written. For example, we might want different flows for an engineer, a SOC team member, and a CISO.

## API and Clients

The app is designed to allow different clients to connect to and use the API, including Slack webhooks, CI integrations, CLI applications, and others, depending on client demand. As an MVP, it should be as open to extension in the places where I forsee change in, while keeping the parts I forsee as as stable to be close for modification.

Each client could be a wrapper around the API, which would also remain directly accessible.

## Report Storage

Reports are saved as immutable JSONB documents in PostgreSQL to support different kinds of reports for different users, such as premium and free tiers, and changes to report schemas over time.

I view a report as a document, similar to one in a document database, and do not want to enforce a uniform structure across all reports. In contrast, scans and repositories have fixed structures in this design.

## Use of LLMs

I used LLMs heavily to achieve as much as possible in the shortest time, while keeping control over the code and especially the design.

I primarily used Codex Sol 6.1, with Claude Sonnet for review and a second opinion. LLMs helped me:

1. Research competitors.
2. Brainstorm the features and design I wanted.
3. Write PRODUCT_SPEC.txt, followed by TECH_SPEC.txt, and decide on storage and other major technical decisions.
4. Implement the app after I had approved the critical happy path
