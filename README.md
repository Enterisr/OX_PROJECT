# OX Interview - POC Security Scanner

## Main Features

The app asynchronously scans a GitHub repository. Each scan is saved in a Neon PostgreSQL database and can have one or more reports.

The scanner currently checks a predefined set of common problems in Node.js applications and uses OSV to check dependencies in the lockfile.

I tried to make it as helpful as possible with action grouping and simple report scheama, that will allow user to look at a fixed summary, and keep it seperate from "words" kind of analisys. It's more than a simple scanner API in the way its impld too- you can know how much of a scan has been done, its completly transparent,and for each scan see what the results are.

Each component—ReportBuilder, Scanner, RepositoryReader, and others, impls an interface, allowing different implementations to be swapped in easily once written. For example, we might want different flows for an engineer, a SOC team member, and a CISO.

## API and Clients

The app is designed to allow different clients to connect to and use the API, including Slack webhooks, CI integrations, CLI applications, and others, depending on client demand. As an MVP, it should be as open to extension in the places where I forsee change in, while keeping the parts I forsee as as stable to be close for modification.

Each client could be a wrapper around the API, which would also remain directly accessible.

## Report

Reports are saved as immutable JSONB documents in PostgreSQL to support different kinds of reports for different users, such as premium and free tiers, and changes to report schemas over time.

I view a report as a document, similar to one in a document database, and do not want to enforce a uniform structure across all reports. In contrast, scans and repositories have fixed structures in this design.

Even the basic report will allow you to **make a desicion** faster about what's needed to be done, by grouping problems that are related to the same dep.

## Use of LLMs

I used LLMs heavily to achieve as much as possible in the shortest time, while keeping control over the code and especially the design.

I primarily used Codex Sol 6.1, with Claude Sonnet for review and a second opinion. LLMs helped me:

1. Research competitors.
2. Brainstorm the features and design I wanted.
3. Write PRODUCT_SPEC.txt, followed by TECH_SPEC.txt, and decide on storage and other major technical decisions.
4. Implement the app after I had approved the critical happy path

## Tests

There is one intergration test and a few unit tests to check for common edge cases. For a prod env I would have done more unit tests.

## Run

Requires Node.js 22+ and a PostgreSQL database, either local or hosted.

1. Install dependencies: `npm ci`.
2. Create a `.env` file in the project root. Set `DATABASE_URL` to your Neon connection string or a local PostgreSQL connection string:

   ```env
   # Local PostgreSQL
   DATABASE_URL=postgresql://user:password@localhost:5432/security_scan

   # Or Neon: use the connection string from your Neon project
   # DATABASE_URL=postgresql://user:password@your-endpoint.neon.tech/database?sslmode=require
   ```

3. Create the tables: `npm run db:setup`.
4. Start the app: `npm run dev`.
5. Open http://127.0.0.1:3000 in your browser.
