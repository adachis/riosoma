---
id: named-functions
title: Named functions
summary: Save reusable formulas with parameters, test them, and use them throughout a database.
area: databases
order: 9
level: standard
related: [formulas, fields, templates]
anchors: [database.namedFunctions, namedFunctions.create, field.formula.expression, field.formula.suggestions, namedFunctions.test]
---

Open {{ui:namedFunctions.title}} in the database sidebar. Each function belongs to this database. People with database editing access can create, change, rename, and delete definitions. Each change appears in audit history and can be undone.

## Create and test

Choose the plus button, {{ui:namedFunctions.create}}.  Enter a {{ui:namedFunctions.name}}, ordered {{ui:namedFunctions.parameters}}, and a {{ui:field.formula.expression}}.  For example, `NET` takes `amount, discount` and uses `amount * (1 - discount)`.

Use parameters as bare names or brace references. Names ignore capitalization. Bodies can call built-in functions and other named functions, but cannot read fields directly. Pass field values as arguments. Function and parameter names must be unique, built-in names are reserved, and functions cannot call themselves through any chain of definitions.

In {{ui:field.formula.suggestions}}, Up and Down choose a function or parameter. Enter or Tab inserts it, and Escape dismisses suggestions.

Use {{ui:namedFunctions.test.title}} before saving.  Enter a formula expression for each sample argument: numbers such as `100`, quoted text such as `"Draft"`, or `BLANK()`.  Choose {{ui:namedFunctions.test.run}} to see the result or a translated error.  Sample arguments are limited to 10,000 characters each, and expressions that exceed the formula's depth or size limits show a translated diagnostic.  Tests do not change records.  Parameter types are checked at each call, so test the kinds of values your fields supply.

Choose {{ui:namedFunctions.save}} to save the definition.  Select a saved function to edit its name, parameters, description, or body.  Long names truncate in the function list, with the full name and parameters in a tooltip.  Its address can be bookmarked or shared with someone who can open the database.

## Use a function in fields

In a formula field's {{ui:field.formula.expression}}, call `NET({Amount}, {Discount})`.  {{ui:field.formula.suggestions}} includes saved functions with their parameters and descriptions.  Completing a function name in an existing call keeps its parentheses and arguments.  Changing a definition recomputes fields that call it, including calls through other named functions, lookups, and rollups.  Affected filters, sorts, and color rules update with those values.

## Rename and delete

Renaming or changing parameters can break existing formula calls.  {{ui:field.formula.expression}} keeps field names readable while explaining a missing function or invalid argument.  Update calling functions first, then update formula fields that need the new name or arguments.

{{ui:namedFunctions.delete}} asks for confirmation and names formula fields and other functions that call the definition, including indirect callers. Update calling functions before deleting; the registry must remain valid. Confirming deletion can leave formula fields showing errors. Undo restores the definition and recomputes those fields.

Database duplicates, snapshots, templates, and database archives retain definitions and descriptions. Restored definitions receive new IDs while their names and calls remain intact.
