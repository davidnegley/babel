import { template, traverse, types as t } from "@babel/core";
import type { File } from "@babel/core";
import type { NodePath, Visitor, Scope } from "@babel/traverse";
import ReplaceSupers, {
  environmentVisitor,
} from "@babel/helper-replace-supers";
import memberExpressionToFunctions from "@babel/helper-member-expression-to-functions";
import type {
  Handler,
  HandlerState,
} from "@babel/helper-member-expression-to-functions";
import optimiseCall from "@babel/helper-optimise-call-expression";
import annotateAsPure from "@babel/helper-annotate-as-pure";

import * as ts from "./typescript";

interface PrivateNameMetadata {
  id: t.Identifier;
  static: boolean;
  method: boolean;
  getId?: t.Identifier;
  setId?: t.Identifier;
  methodId?: t.Identifier;
  initAdded?: boolean;
  getterDeclared?: boolean;
  setterDeclared?: boolean;
}

type PrivateNamesMap = Map<string, PrivateNameMetadata>;

export function buildPrivateNamesMap(props: PropPath[]) {
  const privateNamesMap: PrivateNamesMap = new Map();
  for (const prop of props) {
    if (prop.isPrivate()) {
      const { name } = prop.node.key.id;
      const update: PrivateNameMetadata = privateNamesMap.has(name)
        ? privateNamesMap.get(name)
        : {
            id: prop.scope.generateUidIdentifier(name),
            static: prop.node.static,
            method: !prop.isProperty(),
          };
      if (prop.isClassPrivateMethod()) {
        if (prop.node.kind === "get") {
          update.getId = prop.scope.generateUidIdentifier(`get_${name}`);
        } else if (prop.node.kind === "set") {
          update.setId = prop.scope.generateUidIdentifier(`set_${name}`);
        } else if (prop.node.kind === "method") {
          update.methodId = prop.scope.generateUidIdentifier(name);
        }
      }
      privateNamesMap.set(name, update);
    }
  }
  return privateNamesMap;
}

export function buildPrivateNamesNodes(
  privateNamesMap: PrivateNamesMap,
  privateFieldsAsProperties: boolean,
  state: File,
) {
  const initNodes: t.Statement[] = [];

  for (const [name, value] of privateNamesMap) {
    // When the privateFieldsAsProperties assumption is enabled,
    // both static and instance fields are transpiled using a
    // secret non-enumerable property. Hence, we also need to generate that
    // key (using the classPrivateFieldLooseKey helper).
    // In spec mode, only instance fields need a "private name" initializer
    // because static fields are directly assigned to a variable in the
    // buildPrivateStaticFieldInitSpec function.
    const { static: isStatic, method: isMethod, getId, setId } = value;
    const isAccessor = getId || setId;
    const id = t.cloneNode(value.id);

    let init: t.Expression;

    if (privateFieldsAsProperties) {
      init = t.callExpression(state.addHelper("classPrivateFieldLooseKey"), [
        t.stringLiteral(name),
      ]);
    } else if (!isStatic) {
      init = t.newExpression(
        t.identifier(!isMethod || isAccessor ? "WeakMap" : "WeakSet"),
        [],
      );
    }

    if (init) {
      annotateAsPure(init);
      initNodes.push(template.statement.ast`var ${id} = ${init}`);
    }
  }

  return initNodes;
}

interface PrivateNameVisitorState {
  privateNamesMap: PrivateNamesMap;
  privateFieldsAsProperties: boolean;
  redeclared?: string[];
}

// Traverses the class scope, handling private name references. If an inner
// class redeclares the same private name, it will hand off traversal to the
// restricted visitor (which doesn't traverse the inner class's inner scope).
function privateNameVisitorFactory<S>(
  visitor: Visitor<PrivateNameVisitorState & S>,
) {
  const privateNameVisitor: Visitor<PrivateNameVisitorState & S> = {
    ...visitor,

    Class(path) {
      const { privateNamesMap } = this;
      const body = path.get("body.body");

      const visiblePrivateNames = new Map(privateNamesMap);
      const redeclared = [];
      for (const prop of body) {
        if (!prop.isPrivate()) continue;
        const { name } = prop.node.key.id;
        visiblePrivateNames.delete(name);
        redeclared.push(name);
      }

      // If the class doesn't redeclare any private fields, we can continue with
      // our overall traversal.
      if (!redeclared.length) {
        return;
      }

      // This class redeclares some private field. We need to process the outer
      // environment with access to all the outer privates, then we can process
      // the inner environment with only the still-visible outer privates.
      path.get("body").traverse(nestedVisitor, {
        ...this,
        redeclared,
      });
      path.traverse(privateNameVisitor, {
        ...this,
        privateNamesMap: visiblePrivateNames,
      });

      // We'll eventually hit this class node again with the overall Class
      // Features visitor, which'll process the redeclared privates.
      path.skipKey("body");
    },
  };

  // Traverses the outer portion of a class, without touching the class's inner
  // scope, for private names.
  const nestedVisitor = traverse.visitors.merge([
    {
      ...visitor,
    },
    environmentVisitor,
  ]);

  return privateNameVisitor;
}

interface PrivateNameState {
  privateNamesMap: PrivateNamesMap;
  classRef: t.Identifier;
  file: File;
  noDocumentAll: boolean;
  innerBinding?: t.Identifier;
}

const privateNameVisitor = privateNameVisitorFactory<
  HandlerState<PrivateNameState> & PrivateNameState
>({
  PrivateName(path, { noDocumentAll }) {
    const { privateNamesMap, redeclared } = this;
    const { node, parentPath } = path;

    if (
      !parentPath.isMemberExpression({ property: node }) &&
      !parentPath.isOptionalMemberExpression({ property: node })
    ) {
      return;
    }
    const { name } = node.id;
    if (!privateNamesMap.has(name)) return;
    if (redeclared && redeclared.includes(name)) return;

    this.handle(parentPath, noDocumentAll);
  },
});

// rename all bindings that shadows innerBinding
function unshadow(
  name: string,
  scope: Scope,
  innerBinding: t.Identifier | undefined,
) {
  // in some cases, scope.getBinding(name) === undefined
  // so we check hasBinding to avoid keeping looping
  // see: https://github.com/babel/babel/pull/13656#discussion_r686030715
  while (
    scope?.hasBinding(name) &&
    !scope.bindingIdentifierEquals(name, innerBinding)
  ) {
    scope.rename(name);
    scope = scope.parent;
  }
}

const privateInVisitor = privateNameVisitorFactory<{
  classRef: t.Identifier;
  file: File;
  innerBinding?: t.Identifier;
}>({
  BinaryExpression(path) {
    const { operator, left, right } = path.node;
    if (operator !== "in") return;
    if (!t.isPrivateName(left)) return;

    const { privateFieldsAsProperties, privateNamesMap, redeclared } = this;

    const { name } = left.id;

    if (!privateNamesMap.has(name)) return;
    if (redeclared && redeclared.includes(name)) return;

    // if there are any local variable shadowing classRef, unshadow it
    // see #12960
    unshadow(this.classRef.name, path.scope, this.innerBinding);

    if (privateFieldsAsProperties) {
      const { id } = privateNamesMap.get(name);
      path.replaceWith(template.expression.ast`
        Object.prototype.hasOwnProperty.call(${right}, ${t.cloneNode(id)})
      `);
      return;
    }

    const { id, static: isStatic } = privateNamesMap.get(name);

    if (isStatic) {
      path.replaceWith(template.expression.ast`${right} === ${this.classRef}`);
      return;
    }

    path.replaceWith(template.expression.ast`${t.cloneNode(id)}.has(${right})`);
  },
});

interface Receiver {
  receiver(
    this: HandlerState<PrivateNameState> & PrivateNameState,
    member: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
  ): t.Expression;
}

const privateNameHandlerSpec: Handler<PrivateNameState & Receiver> & Receiver =
  {
    memoise(member, count) {
      const { scope } = member;
      const { object } = member.node;

      const memo = scope.maybeGenerateMemoised(object);
      if (!memo) {
        return;
      }

      this.memoiser.set(object, memo, count);
    },

    receiver(member) {
      const { object } = member.node;

      if (this.memoiser.has(object)) {
        return t.cloneNode(this.memoiser.get(object) as t.Expression);
      }

      return t.cloneNode(object);
    },

    get(member) {
      const { classRef, privateNamesMap, file, innerBinding } = this;
      const { name } = (member.node.property as t.PrivateName).id;
      const {
        id,
        static: isStatic,
        method: isMethod,
        methodId,
        getId,
        setId,
      } = privateNamesMap.get(name);
      const isAccessor = getId || setId;

      if (isStatic) {
        const helperName =
          isMethod && !isAccessor
            ? "classStaticPrivateMethodGet"
            : "classStaticPrivateFieldSpecGet";

        // if there are any local variable shadowing classRef, unshadow it
        // see #12960
        unshadow(classRef.name, member.scope, innerBinding);

        return t.callExpression(file.addHelper(helperName), [
          this.receiver(member),
          t.cloneNode(classRef),
          t.cloneNode(id),
        ]);
      }

      if (isMethod) {
        if (isAccessor) {
          if (!getId && setId) {
            if (file.availableHelper("writeOnlyError")) {
              return t.sequenceExpression([
                this.receiver(member),
                t.callExpression(file.addHelper("writeOnlyError"), [
                  t.stringLiteral(`#${name}`),
                ]),
              ]);
            }
            console.warn(
              `@babel/helpers is outdated, update it to silence this warning.`,
            );
          }
          return t.callExpression(file.addHelper("classPrivateFieldGet"), [
            this.receiver(member),
            t.cloneNode(id),
          ]);
        }
        return t.callExpression(file.addHelper("classPrivateMethodGet"), [
          this.receiver(member),
          t.cloneNode(id),
          t.cloneNode(methodId),
        ]);
      }
      return t.callExpression(file.addHelper("classPrivateFieldGet"), [
        this.receiver(member),
        t.cloneNode(id),
      ]);
    },

    boundGet(member) {
      this.memoise(member, 1);

      return t.callExpression(
        t.memberExpression(this.get(member), t.identifier("bind")),
        [this.receiver(member)],
      );
    },

    set(member, value) {
      const { classRef, privateNamesMap, file } = this;
      const { name } = (member.node.property as t.PrivateName).id;
      const {
        id,
        static: isStatic,
        method: isMethod,
        setId,
        getId,
      } = privateNamesMap.get(name);
      const isAccessor = getId || setId;

      if (isStatic) {
        const helperName =
          isMethod && !isAccessor
            ? "classStaticPrivateMethodSet"
            : "classStaticPrivateFieldSpecSet";

        return t.callExpression(file.addHelper(helperName), [
          this.receiver(member),
          t.cloneNode(classRef),
          t.cloneNode(id),
          value,
        ]);
      }
      if (isMethod) {
        if (setId) {
          return t.callExpression(file.addHelper("classPrivateFieldSet"), [
            this.receiver(member),
            t.cloneNode(id),
            value,
          ]);
        }
        return t.sequenceExpression([
          this.receiver(member),
          value,
          t.callExpression(file.addHelper("readOnlyError"), [
            t.stringLiteral(`#${name}`),
          ]),
        ]);
      }
      return t.callExpression(file.addHelper("classPrivateFieldSet"), [
        this.receiver(member),
        t.cloneNode(id),
        value,
      ]);
    },

    destructureSet(member) {
      const { classRef, privateNamesMap, file } = this;
      const { name } = (member.node.property as t.PrivateName).id;
      const { id, static: isStatic } = privateNamesMap.get(name);
      if (isStatic) {
        try {
          // classStaticPrivateFieldDestructureSet was introduced in 7.13.10
          // eslint-disable-next-line no-var
          var helper = file.addHelper("classStaticPrivateFieldDestructureSet");
        } catch {
          throw new Error(
            "Babel can not transpile `[C.#p] = [0]` with @babel/helpers < 7.13.10, \n" +
              "please update @babel/helpers to the latest version.",
          );
        }
        return t.memberExpression(
          t.callExpression(helper, [
            this.receiver(member),
            t.cloneNode(classRef),
            t.cloneNode(id),
          ]),
          t.identifier("value"),
        );
      }

      return t.memberExpression(
        t.callExpression(file.addHelper("classPrivateFieldDestructureSet"), [
          this.receiver(member),
          t.cloneNode(id),
        ]),
        t.identifier("value"),
      );
    },

    call(member, args: (t.Expression | t.SpreadElement)[]) {
      // The first access (the get) should do the memo assignment.
      this.memoise(member, 1);

      return optimiseCall(this.get(member), this.receiver(member), args, false);
    },

    optionalCall(member, args: (t.Expression | t.SpreadElement)[]) {
      this.memoise(member, 1);

      return optimiseCall(this.get(member), this.receiver(member), args, true);
    },
  };

const privateNameHandlerLoose: Handler<PrivateNameState> = {
  get(member) {
    const { privateNamesMap, file } = this;
    const { object } = member.node;
    const { name } = (member.node.property as t.PrivateName).id;

    return template.expression`BASE(REF, PROP)[PROP]`({
      BASE: file.addHelper("classPrivateFieldLooseBase"),
      REF: t.cloneNode(object),
      PROP: t.cloneNode(privateNamesMap.get(name).id),
    });
  },

  set() {
    // noop
    throw new Error("private name handler with loose = true don't need set()");
  },

  boundGet(member) {
    return t.callExpression(
      t.memberExpression(this.get(member), t.identifier("bind")),
      [t.cloneNode(member.node.object)],
    );
  },

  simpleSet(member) {
    return this.get(member);
  },

  destructureSet(member) {
    return this.get(member);
  },

  call(member, args) {
    return t.callExpression(this.get(member), args);
  },

  optionalCall(member, args) {
    return t.optionalCallExpression(this.get(member), args, true);
  },
};

export function transformPrivateNamesUsage(
  ref: t.Identifier,
  path: NodePath<t.Class>,
  privateNamesMap: PrivateNamesMap,
  { privateFieldsAsProperties, noDocumentAll, innerBinding },
  state: File,
) {
  if (!privateNamesMap.size) return;

  const body = path.get("body");
  const handler = privateFieldsAsProperties
    ? privateNameHandlerLoose
    : privateNameHandlerSpec;

  memberExpressionToFunctions<PrivateNameState>(body, privateNameVisitor, {
    privateNamesMap,
    classRef: ref,
    file: state,
    ...handler,
    noDocumentAll,
    innerBinding,
  });
  body.traverse(privateInVisitor, {
    privateNamesMap,
    classRef: ref,
    file: state,
    privateFieldsAsProperties,
    innerBinding,
  });
}

function buildPrivateFieldInitLoose(
  ref: t.Expression,
  prop: NodePath<t.ClassPrivateProperty>,
  privateNamesMap: PrivateNamesMap,
) {
  const { id } = privateNamesMap.get(prop.node.key.id.name);
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  return template.statement.ast`
    Object.defineProperty(${ref}, ${t.cloneNode(id)}, {
      // configurable is false by default
      // enumerable is false by default
      writable: true,
      value: ${value}
    });
  `;
}

function buildPrivateInstanceFieldInitSpec(
  ref: t.Expression,
  prop: NodePath<t.ClassPrivateProperty>,
  privateNamesMap: PrivateNamesMap,
  state,
) {
  const { id } = privateNamesMap.get(prop.node.key.id.name);
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  if (!process.env.BABEL_8_BREAKING) {
    if (!state.availableHelper("classPrivateFieldInitSpec")) {
      return template.statement.ast`${t.cloneNode(id)}.set(${ref}, {
        // configurable is always false for private elements
        // enumerable is always false for private elements
        writable: true,
        value: ${value},
      })`;
    }
  }

  const helper = state.addHelper("classPrivateFieldInitSpec");
  return template.statement.ast`${helper}(
    ${t.thisExpression()},
    ${t.cloneNode(id)},
    {
      writable: true,
      value: ${value}
    },
  )`;
}

function buildPrivateStaticFieldInitSpec(
  prop: NodePath<t.ClassPrivateProperty>,
  privateNamesMap: PrivateNamesMap,
) {
  const privateName = privateNamesMap.get(prop.node.key.id.name);
  const { id, getId, setId, initAdded } = privateName;
  const isAccessor = getId || setId;

  if (!prop.isProperty() && (initAdded || !isAccessor)) return;

  if (isAccessor) {
    privateNamesMap.set(prop.node.key.id.name, {
      ...privateName,
      initAdded: true,
    });

    return template.statement.ast`
      var ${t.cloneNode(id)} = {
        // configurable is false by default
        // enumerable is false by default
        // writable is false by default
        get: ${getId ? getId.name : prop.scope.buildUndefinedNode()},
        set: ${setId ? setId.name : prop.scope.buildUndefinedNode()}
      }
    `;
  }

  const value = prop.node.value || prop.scope.buildUndefinedNode();
  return template.statement.ast`
    var ${t.cloneNode(id)} = {
      // configurable is false by default
      // enumerable is false by default
      writable: true,
      value: ${value}
    };
  `;
}

function buildPrivateMethodInitLoose(
  ref: t.Expression,
  prop: NodePath<t.ClassPrivateMethod>,
  privateNamesMap: PrivateNamesMap,
) {
  const privateName = privateNamesMap.get(prop.node.key.id.name);
  const { methodId, id, getId, setId, initAdded } = privateName;
  if (initAdded) return;

  if (methodId) {
    return template.statement.ast`
        Object.defineProperty(${ref}, ${id}, {
          // configurable is false by default
          // enumerable is false by default
          // writable is false by default
          value: ${methodId.name}
        });
      `;
  }
  const isAccessor = getId || setId;
  if (isAccessor) {
    privateNamesMap.set(prop.node.key.id.name, {
      ...privateName,
      initAdded: true,
    });

    return template.statement.ast`
      Object.defineProperty(${ref}, ${id}, {
        // configurable is false by default
        // enumerable is false by default
        // writable is false by default
        get: ${getId ? getId.name : prop.scope.buildUndefinedNode()},
        set: ${setId ? setId.name : prop.scope.buildUndefinedNode()}
      });
    `;
  }
}

function buildPrivateInstanceMethodInitSpec(
  ref: t.Expression,
  prop: NodePath<t.ClassPrivateMethod>,
  privateNamesMap: PrivateNamesMap,
  state,
) {
  const privateName = privateNamesMap.get(prop.node.key.id.name);
  const { getId, setId, initAdded } = privateName;

  if (initAdded) return;

  const isAccessor = getId || setId;
  if (isAccessor) {
    return buildPrivateAccessorInitialization(
      ref,
      prop,
      privateNamesMap,
      state,
    );
  }

  return buildPrivateInstanceMethodInitalization(
    ref,
    prop,
    privateNamesMap,
    state,
  );
}

function buildPrivateAccessorInitialization(
  ref: t.Expression,
  prop: NodePath<t.ClassPrivateMethod>,
  privateNamesMap: PrivateNamesMap,
  state,
) {
  const privateName = privateNamesMap.get(prop.node.key.id.name);
  const { id, getId, setId } = privateName;

  privateNamesMap.set(prop.node.key.id.name, {
    ...privateName,
    initAdded: true,
  });

  if (!process.env.BABEL_8_BREAKING) {
    if (!state.availableHelper("classPrivateFieldInitSpec")) {
      return template.statement.ast`
      ${id}.set(${ref}, {
        get: ${getId ? getId.name : prop.scope.buildUndefinedNode()},
        set: ${setId ? setId.name : prop.scope.buildUndefinedNode()}
      });
    `;
    }
  }

  const helper = state.addHelper("classPrivateFieldInitSpec");
  return template.statement.ast`${helper}(
    ${t.thisExpression()},
    ${t.cloneNode(id)},
    {
      get: ${getId ? getId.name : prop.scope.buildUndefinedNode()},
      set: ${setId ? setId.name : prop.scope.buildUndefinedNode()}
    },
  )`;
}

function buildPrivateInstanceMethodInitalization(
  ref: t.Expression,
  prop: NodePath<t.ClassPrivateMethod>,
  privateNamesMap: PrivateNamesMap,
  state,
) {
  const privateName = privateNamesMap.get(prop.node.key.id.name);
  const { id } = privateName;

  if (!process.env.BABEL_8_BREAKING) {
    if (!state.availableHelper("classPrivateMethodInitSpec")) {
      return template.statement.ast`${id}.add(${ref})`;
    }
  }

  const helper = state.addHelper("classPrivateMethodInitSpec");
  return template.statement.ast`${helper}(
    ${t.thisExpression()},
    ${t.cloneNode(id)}
  )`;
}

function buildPublicFieldInitLoose(
  ref: t.Expression,
  prop: NodePath<t.ClassProperty>,
) {
  const { key, computed } = prop.node;
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  return t.expressionStatement(
    t.assignmentExpression(
      "=",
      t.memberExpression(ref, key, computed || t.isLiteral(key)),
      value,
    ),
  );
}

function buildPublicFieldInitSpec(
  ref: t.Expression,
  prop: NodePath<t.ClassProperty>,
  state,
) {
  const { key, computed } = prop.node;
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  return t.expressionStatement(
    t.callExpression(state.addHelper("defineProperty"), [
      ref,
      computed || t.isLiteral(key)
        ? key
        : t.stringLiteral((key as t.Identifier).name),
      value,
    ]),
  );
}

function buildPrivateStaticMethodInitLoose(
  ref: t.Expression,
  prop: NodePath<t.ClassPrivateMethod>,
  state,
  privateNamesMap: PrivateNamesMap,
) {
  const privateName = privateNamesMap.get(prop.node.key.id.name);
  const { id, methodId, getId, setId, initAdded } = privateName;

  if (initAdded) return;

  const isAccessor = getId || setId;
  if (isAccessor) {
    privateNamesMap.set(prop.node.key.id.name, {
      ...privateName,
      initAdded: true,
    });

    return template.statement.ast`
      Object.defineProperty(${ref}, ${id}, {
        // configurable is false by default
        // enumerable is false by default
        // writable is false by default
        get: ${getId ? getId.name : prop.scope.buildUndefinedNode()},
        set: ${setId ? setId.name : prop.scope.buildUndefinedNode()}
      })
    `;
  }

  return template.statement.ast`
    Object.defineProperty(${ref}, ${id}, {
      // configurable is false by default
      // enumerable is false by default
      // writable is false by default
      value: ${methodId.name}
    });
  `;
}

function buildPrivateMethodDeclaration(
  prop: NodePath<t.ClassPrivateMethod>,
  privateNamesMap: PrivateNamesMap,
  privateFieldsAsProperties = false,
) {
  const privateName = privateNamesMap.get(prop.node.key.id.name);
  const {
    id,
    methodId,
    getId,
    setId,
    getterDeclared,
    setterDeclared,
    static: isStatic,
  } = privateName;
  const { params, body, generator, async } = prop.node;
  const isGetter = getId && !getterDeclared && params.length === 0;
  const isSetter = setId && !setterDeclared && params.length > 0;

  let declId = methodId;

  if (isGetter) {
    privateNamesMap.set(prop.node.key.id.name, {
      ...privateName,
      getterDeclared: true,
    });
    declId = getId;
  } else if (isSetter) {
    privateNamesMap.set(prop.node.key.id.name, {
      ...privateName,
      setterDeclared: true,
    });
    declId = setId;
  } else if (isStatic && !privateFieldsAsProperties) {
    declId = id;
  }

  return t.functionDeclaration(
    t.cloneNode(declId),
    // @ts-expect-error params for ClassMethod has TSParameterProperty
    params,
    body,
    generator,
    async,
  );
}

const thisContextVisitor = traverse.visitors.merge([
  {
    ThisExpression(path, state) {
      state.needsClassRef = true;
      path.replaceWith(t.cloneNode(state.classRef));
    },
    MetaProperty(path: NodePath<t.MetaProperty>) {
      const meta = path.get("meta");
      const property = path.get("property");
      const { scope } = path;
      // if there are `new.target` in static field
      // we should replace it with `undefined`
      if (
        meta.isIdentifier({ name: "new" }) &&
        property.isIdentifier({ name: "target" })
      ) {
        path.replaceWith(scope.buildUndefinedNode());
      }
    },
  },
  environmentVisitor,
]);

const innerReferencesVisitor = {
  ReferencedIdentifier(path: NodePath<t.Identifier>, state) {
    if (
      path.scope.bindingIdentifierEquals(path.node.name, state.innerBinding)
    ) {
      state.needsClassRef = true;
      path.node.name = state.classRef.name;
    }
  },
};

function replaceThisContext(
  path: PropPath,
  ref: t.Identifier,
  getSuperRef: () => t.Identifier,
  file: File,
  isStaticBlock: boolean,
  constantSuper: boolean,
  innerBindingRef: t.Identifier,
) {
  const state = {
    classRef: ref,
    needsClassRef: false,
    innerBinding: innerBindingRef,
  };

  const replacer = new ReplaceSupers({
    methodPath: path,
    constantSuper,
    file,
    refToPreserve: ref,
    getSuperRef,
    getObjectRef() {
      state.needsClassRef = true;
      return isStaticBlock || path.node.static
        ? ref
        : t.memberExpression(ref, t.identifier("prototype"));
    },
  });
  replacer.replace();
  if (isStaticBlock || path.isProperty()) {
    path.traverse(thisContextVisitor, state);
  }

  if (state.classRef?.name && state.classRef.name !== innerBindingRef?.name) {
    path.traverse(innerReferencesVisitor, state);
  }

  return state.needsClassRef;
}

export type PropNode =
  | t.ClassProperty
  | t.ClassPrivateMethod
  | t.ClassPrivateProperty;
export type PropPath = NodePath<PropNode>;

export function buildFieldsInitNodes(
  ref: t.Identifier,
  superRef: t.Expression | undefined,
  props: PropPath[],
  privateNamesMap: PrivateNamesMap,
  state: File,
  setPublicClassFields: boolean,
  privateFieldsAsProperties: boolean,
  constantSuper: boolean,
  innerBindingRef: t.Identifier,
) {
  let needsClassRef = false;
  let injectSuperRef: t.Identifier;
  const staticNodes: t.Statement[] = [];
  const instanceNodes: t.Statement[] = [];
  // These nodes are pure and can be moved to the closest statement position
  const pureStaticNodes: t.FunctionDeclaration[] = [];

  const getSuperRef = t.isIdentifier(superRef)
    ? () => superRef
    : () => {
        injectSuperRef ??=
          props[0].scope.generateUidIdentifierBasedOnNode(superRef);
        return injectSuperRef;
      };

  for (const prop of props) {
    prop.isClassProperty() && ts.assertFieldTransformed(prop);

    const isStatic = prop.node.static;
    const isInstance = !isStatic;
    const isPrivate = prop.isPrivate();
    const isPublic = !isPrivate;
    const isField = prop.isProperty();
    const isMethod = !isField;
    const isStaticBlock = prop.isStaticBlock?.();

    if (isStatic || (isMethod && isPrivate) || isStaticBlock) {
      const replaced = replaceThisContext(
        prop,
        ref,
        getSuperRef,
        state,
        isStaticBlock,
        constantSuper,
        innerBindingRef,
      );
      needsClassRef = needsClassRef || replaced;
    }

    // TODO(ts): there are so many `ts-expect-error` inside cases since
    // ts can not infer type from pre-computed values (or a case test)
    // even change `isStaticBlock` to `t.isStaticBlock(prop)` will not make prop
    // a `NodePath<t.StaticBlock>`
    // this maybe a bug for ts
    switch (true) {
      case isStaticBlock:
        staticNodes.push(
          // @ts-expect-error prop is `StaticBlock` here
          template.statement.ast`(() => ${t.blockStatement(prop.node.body)})()`,
        );
        break;
      case isStatic && isPrivate && isField && privateFieldsAsProperties:
        needsClassRef = true;
        staticNodes.push(
          // @ts-expect-error checked in switch
          buildPrivateFieldInitLoose(t.cloneNode(ref), prop, privateNamesMap),
        );
        break;
      case isStatic && isPrivate && isField && !privateFieldsAsProperties:
        needsClassRef = true;
        staticNodes.push(
          // @ts-expect-error checked in switch
          buildPrivateStaticFieldInitSpec(prop, privateNamesMap),
        );
        break;
      case isStatic && isPublic && isField && setPublicClassFields:
        needsClassRef = true;
        // @ts-expect-error checked in switch
        staticNodes.push(buildPublicFieldInitLoose(t.cloneNode(ref), prop));
        break;
      case isStatic && isPublic && isField && !setPublicClassFields:
        needsClassRef = true;
        staticNodes.push(
          // @ts-expect-error checked in switch
          buildPublicFieldInitSpec(t.cloneNode(ref), prop, state),
        );
        break;
      case isInstance && isPrivate && isField && privateFieldsAsProperties:
        instanceNodes.push(
          // @ts-expect-error checked in switch
          buildPrivateFieldInitLoose(t.thisExpression(), prop, privateNamesMap),
        );
        break;
      case isInstance && isPrivate && isField && !privateFieldsAsProperties:
        instanceNodes.push(
          buildPrivateInstanceFieldInitSpec(
            t.thisExpression(),
            // @ts-expect-error checked in switch
            prop,
            privateNamesMap,
            state,
          ),
        );
        break;
      case isInstance && isPrivate && isMethod && privateFieldsAsProperties:
        instanceNodes.unshift(
          buildPrivateMethodInitLoose(
            t.thisExpression(),
            // @ts-expect-error checked in switch
            prop,
            privateNamesMap,
          ),
        );
        pureStaticNodes.push(
          buildPrivateMethodDeclaration(
            // @ts-expect-error checked in switch
            prop,
            privateNamesMap,
            privateFieldsAsProperties,
          ),
        );
        break;
      case isInstance && isPrivate && isMethod && !privateFieldsAsProperties:
        instanceNodes.unshift(
          buildPrivateInstanceMethodInitSpec(
            t.thisExpression(),
            // @ts-expect-error checked in switch
            prop,
            privateNamesMap,
            state,
          ),
        );
        pureStaticNodes.push(
          buildPrivateMethodDeclaration(
            // @ts-expect-error checked in switch
            prop,
            privateNamesMap,
            privateFieldsAsProperties,
          ),
        );
        break;
      case isStatic && isPrivate && isMethod && !privateFieldsAsProperties:
        needsClassRef = true;
        staticNodes.unshift(
          // @ts-expect-error checked in switch
          buildPrivateStaticFieldInitSpec(prop, privateNamesMap),
        );
        pureStaticNodes.push(
          buildPrivateMethodDeclaration(
            // @ts-expect-error checked in switch
            prop,
            privateNamesMap,
            privateFieldsAsProperties,
          ),
        );
        break;
      case isStatic && isPrivate && isMethod && privateFieldsAsProperties:
        needsClassRef = true;
        staticNodes.unshift(
          buildPrivateStaticMethodInitLoose(
            t.cloneNode(ref),
            // @ts-expect-error checked in switch
            prop,
            state,
            privateNamesMap,
          ),
        );
        pureStaticNodes.push(
          buildPrivateMethodDeclaration(
            // @ts-expect-error checked in switch
            prop,
            privateNamesMap,
            privateFieldsAsProperties,
          ),
        );
        break;
      case isInstance && isPublic && isField && setPublicClassFields:
        // @ts-expect-error checked in switch
        instanceNodes.push(buildPublicFieldInitLoose(t.thisExpression(), prop));
        break;
      case isInstance && isPublic && isField && !setPublicClassFields:
        instanceNodes.push(
          // @ts-expect-error checked in switch
          buildPublicFieldInitSpec(t.thisExpression(), prop, state),
        );
        break;
      default:
        throw new Error("Unreachable.");
    }
  }

  return {
    staticNodes: staticNodes.filter(Boolean),
    instanceNodes: instanceNodes.filter(Boolean),
    pureStaticNodes: pureStaticNodes.filter(Boolean),
    wrapClass(path: NodePath<t.Class>) {
      for (const prop of props) {
        prop.remove();
      }

      if (injectSuperRef) {
        path.scope.push({ id: t.cloneNode(injectSuperRef) });
        path.set(
          "superClass",
          t.assignmentExpression("=", injectSuperRef, path.node.superClass),
        );
      }

      if (!needsClassRef) return path;

      if (path.isClassExpression()) {
        path.scope.push({ id: ref });
        path.replaceWith(
          t.assignmentExpression("=", t.cloneNode(ref), path.node),
        );
      } else if (!path.node.id) {
        // Anonymous class declaration
        path.node.id = ref;
      }

      return path;
    },
  };
}
