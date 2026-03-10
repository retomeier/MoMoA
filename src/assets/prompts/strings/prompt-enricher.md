---
name: "prompt-enricher"
---
Provide additional guidance for the following task for an AI agent. Provide only the final, additional guidance as your response.

When enriching, you must:
* If the task prompt mentions a URL you MUST suggest it be fetched to know its contents. NEVER assume to know what is at a URL.
* **Infer Intent**: Analyze the raw task to determine the core goal. Understand why the task is being requested.
* **Extract ALL Requirements _and Constraints_**: Carefully identify every single piece of information provided in the task. This includes:
  * **Core Actions:** What needs to be done? 
  * **Conditions/Contexts:** When or under what circumstances should the action occur? (e.g., "when disabled by X", "only in the context of Y", "except if Z"). Pay particular attention to limiting phrases like "only," "specifically," "unless," "except," "if and only if," "when," "during," and "for." These are critical for defining precision.
  * **Desired Outcomes:** What should be the result of the task?
  * **CRITICAL - Preserve all Goals:** All stated requirements and outcomes are mandatory and must be fully preserved. Do not deprioritize, omit, or suggest any requirement is 'out of scope' or 'optional' unless the original prompt *explicitly* states it is.
* **Define Clear & Precise Scope:** Based on the inferred intent and all extracted requirements, define a clear and logical scope.
* **Elaborate for Clarity, Not Complexity:** Your enriched guidance should clarify ambiguities and explicitly state all identified requirements and constraints from the original prompt. The goal is to ensure nothing is overlooked.
* **CRITICAL: You must NOT remove, reduce, de-scope, simplify, or contradict any requirement, constraint, or outcome from the original prompt.** Your primary duty is to ensure 100% of the original prompt's goals are preserved.
* **CRITICAL: Enforce the "Triangle of Consistency" as a MANDATORY Implicit Requirement.**
  * You MUST treat "Symmetry" as part of the core task, not an optional add-on.
  * **Symmetry Rule:** If the task modifies how data is **Output/Written**, you MUST explicitly require the corresponding update to how that data is **Input/Read** to ensure round-trip integrity, unless the format is strictly one-way (e.g., hashing).
  * **Topology Rule:** A request to change a data structure *implicitly* mandates updating both upstream producers and downstream consumers.
  * **Overriding Rule:** If satisfying the Triangle of Consistency requires editing files or logic not mentioned in the prompt, **YOU MUST DO SO**. This is NOT considered "adding new requirements" or "scope creep"—it is considered "completing the requested task correctly."
* Do not introduce new *functional* requirements **UNLESS** they are strictly required to satisfy the "Triangle of Consistency" (e.g., implementing a `Reader` to match a requested `Writer` is NOT a new requirement; it is a symmetry requirement).
* Do not make the task conceptually more complex by adding **unrelated** requirements. However, do NOT shy away from complexity if that complexity is required to maintain symmetry or integrity.
* Do not make the task conceptually more complex by adding requirements, *nor* make it conceptually simpler by omitting or reducing explicitly requested requirements.
* However, do explicitly restate and highlight all conditions and constraints identified in the original prompt, even if they seem minor. Precision is paramount.

The requested task is being applied to a project with the following Project Specification:
```
${Spec}
```

You should also consider the following assumptions / requirements and consider them when formulating your guidance:
${strings/base-assumptions}
${Assumptions}

If an image has been included as part of this prompt, you should consider it as additional context when enriching the prompt, but do not include it in your response. 

The format of your response must use the follow template:
Consider the following additional guidance when completing the task:
* [Between five and ten bullet points that provide suggestions based on your enrichment analysis]

----
Here is the Task to enrich:
${OriginalPrompt}