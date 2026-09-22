# Q3 Financial Reporting Procedure

Owner: John Mwangi (Finance Systems)
Applies to: all departments
Last reviewed: 2026-08-14

## Scope

This procedure covers the preparation, review, and submission of the
quarterly Q3 spreadsheet reports: revenue summary, headcount report, and
department expense variance.

## Preparation

1. Pull the quarter's transactions from the ERP export (CSV, UTF-8).
2. Open the master template at `finance://templates/q3-master.xlsx`.
3. Paste the ERP export into the `Raw` sheet. Do not edit formulas on the
   `Summary` sheet.
4. Reconcile the variance column; any line over 5 percent needs a comment.

## Review

Department leads confirm their numbers by the 10th of the month after
quarter close. John Mwangi consolidates the master workbook and circulates
it for sign-off.

## Submission

The signed workbook is uploaded to the finance share under
`Reports/Q3/<year>/`. Questions about the procedure go to John Mwangi in
Finance Systems.

## Common issues

- Currency mismatch: the template expects KES; convert ERP exports first.
- Missing variance comments block sign-off.
- Do not rename sheets; the consolidation macro depends on sheet names.
