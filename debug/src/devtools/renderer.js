import { getVNodeId, getVNode, clearVNode, hasVNodeId, getPreviousChildrenIds, addChildToParent, removeChildFromParent } from './cache';
import { TREE_OPERATION_ADD, ElementTypeRoot, TREE_OPERATION_REMOVE, TREE_OPERATION_REORDER_CHILDREN, TREE_OPERATION_UPDATE_TREE_BASE_DURATION } from './constants';
import { getVNodeType, getDisplayName, getAncestor, getOwners, getRoot, isRoot } from './vnode';
import { cleanForBridge, cleanContext } from './pretty';
import { inspectHooks } from './hooks';
import { shouldFilter } from './filter';
import { getChangeDescription, setupProfileData } from './profiling';
import { flushTable, getStringId } from './string-table';

/**
 * Called when a tree has completed rendering
 * @param {import('../internal').DevtoolsHook} hook
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 */
export function onCommitFiberRoot(hook, state, vnode) {
	// Some libraries like mobx call `forceUpdate` inside `componentDidMount`.
	// This leads to an issue where `options.commit` is called twice, once
	// for the vnode where the update occured and once on the child vnode
	// somewhere down the tree where `forceUpdate` was called on. The latter
	// will be called first, but because the parents haven't been mounted
	// in the devtools this will lead to an incorrect result.
	// TODO: We should fix this in core instead of patching around it here
	if ((!isRoot(vnode) && !isRoot(vnode._parent)) && !hasVNodeId(vnode)) {
		return;
	}

	// Keep track of mounted roots
	let roots = hook.getFiberRoots(state.rendererId);
	let root;
	if (isRoot(vnode)) {
		roots.add(vnode);
		root = vnode;
	}
	else {
		root = getRoot(vnode);
	}

	// If we're seeing this node for the first time we need to be careful
	// not to set the id, otherwise the mount branch will not be chosen below
	if (hasVNodeId(root)) {
		state.currentRootId = getVNodeId(root);
	}

	if (state.isProfiling) {
		setupProfileData(state);
	}

	let parentId = 0;
	let ancestor = getAncestor(state.filter, vnode);
	if (ancestor!=null) {
		if (hasVNodeId(ancestor)) {
			parentId = getVNodeId(ancestor);
		}
	}

	if (hasVNodeId(vnode)) {
		update(state, vnode, parentId);
	}
	else {
		mount(state, vnode, parentId);
	}

	flushPendingEvents(hook, state);
	state.currentRootId = -1;
}

/**
 * Called when a vonde unmounts
 * @param {import('../internal').DevtoolsHook} hook
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 */
export function onCommitFiberUnmount(hook, state, vnode) {
	// Check if is root
	if (!shouldFilter(state.filter, vnode)) {
		let ancestor = getAncestor(state.filter, vnode);
		if (ancestor && hasVNodeId(vnode) && hasVNodeId(ancestor)) {
			removeChildFromParent(getVNodeId(ancestor), getVNodeId(vnode));
		}
	}
	recordUnmount(state, vnode);
}

/**
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 * @param {number} parentId
 * @returns {boolean}
 */
export function update(state, vnode, parentId) {
	let shouldReset = false;
	let include = !shouldFilter(state.filter, vnode);
	if (include && !hasVNodeId(vnode)) {
		mount(state, vnode, parentId);
		shouldReset = true;
	}
	else {
		let children = vnode._children || [];
		let prevChildren = getPreviousChildrenIds(vnode);

		for (let i = 0; i < children.length; i++) {
			if (children[i]!==null) {
				if (update(state, children[i], include ? getVNodeId(vnode) : parentId)) {
					shouldReset = true;
				}

				if (include && !shouldReset && hasVNodeId(children[i]) && prevChildren[i]!=getVNodeId(children[i])) {
					shouldReset = true;
				}
			}
		}
	}

	if (include) {
		recordProfiling(state, vnode, false);
	}

	if (shouldReset) {
		if (include) {
			if (vnode._children!=null && vnode._children.length > 0) {
				resetChildren(state, vnode);
			}
			return false;
		}

		return true;
	}

	return false;
}

/**
 * Reset child ordering of a vnode
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 */
export function resetChildren(state, vnode) {
	if (!vnode._children) return;

	/** @type {number[]} */
	let next = [];

	let stack = vnode._children.slice();

	let child;
	while ((child = stack.pop())!=null) {
		if (!shouldFilter(state.filter, child)) {
			next.push(getVNodeId(child));
		}
		else if (child._children) {
			stack.push(...child._children);
		}
	}

	if (next.length < 2) return;

	let ops = state.currentCommit.operations;
	ops.push(
		TREE_OPERATION_REORDER_CHILDREN,
		getVNodeId(vnode),
		next.length
	);

	next = next.reverse();
	for (let i = 0; i < next.length; i++) {
		ops.push(next[i]);
	}
}

/**
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 */
export function unmount(state, vnode) {
	let children = vnode._children || [];
	for (let i = 0; i < children.length; i++) {
		if (children[i]!==null) {
			unmount(state, children[i]);
		}
	}

	recordUnmount(state, vnode);
}

/**
 * Extracted unmount logic, because this will be called by
 * `handleCommitFiberUnmount` directly during rendering. For that reason
 * it should be as lightweight as possible to not taint profiling timings too
 * much.
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 */
export function recordUnmount(state, vnode) {
	if (hasVNodeId(vnode)) {
		let id = getVNodeId(vnode);
		if (isRoot(vnode)) {
			state.currentCommit.unmountRootId = id;
		}
		else {
			state.currentCommit.unmountIds.push(id);
		}

		state.vnodeDurations.delete(id);
	}

	clearVNode(vnode);
}

/**
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 * @param {number} parentId
 */
export function mount(state, vnode, parentId) {
	if (!shouldFilter(state.filter, vnode)) {
		let newId = getVNodeId(vnode);
		addChildToParent(parentId, newId);
		recordMount(state, vnode);

		// Our current vnode is the next parent from now on
		parentId = newId;
	}

	const children = vnode._children || [];
	for (let i = 0; i < children.length; i++) {
		if (children[i]!==null) {
			mount(state, children[i], parentId);
		}
	}
}

/**
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 */
export function recordMount(state, vnode) {
	const table = state.stringTable;
	let id = getVNodeId(vnode);
	if (isRoot(vnode)) {
		state.currentCommit.operations.push(
			TREE_OPERATION_ADD,
			id,
			ElementTypeRoot,
			1,
			1
		);
		state.currentRootId = id;
	}
	else {
		let ancestor = getAncestor(state.filter, vnode);
		state.currentCommit.operations.push(
			TREE_OPERATION_ADD,
			id,
			getVNodeType(vnode),
			ancestor!=null ? getVNodeId(ancestor) : 0,
			ancestor!=null && !isRoot(ancestor) ? getVNodeId(ancestor) : 0,
			getStringId(table, getDisplayName(vnode)),
			vnode.key ? getStringId(table, vnode.key + '') : 0
		);
	}

	recordProfiling(state, vnode, true);
}

/**
 * Records profiling timings
 * @param {import('../internal').AdapterState} state
 * @param {import('../internal').VNode} vnode
 * @param {boolean} isNew
 */
export function recordProfiling(state, vnode, isNew) {
	let id = getVNodeId(vnode);
	let duration = vnode.endTime - vnode.startTime;
	state.vnodeDurations.set(id, duration > 0 ? duration : 0);

	if (!state.isProfiling) return;

	let commit = state.currentCommit;
	commit.operations.push(
		TREE_OPERATION_UPDATE_TREE_BASE_DURATION,
		id,
		Math.floor(duration * 1000)
	);
	let selfDuration = duration;

	if (vnode._children) {
		for (let i = 0; i < vnode._children.length; i++) {
			let child = vnode._children[i];
			if (child) {
				let childDuration = child.endTime - child.startTime;
				selfDuration -= childDuration;
			}
		}

		// TODO: Why does this happen?
		if (selfDuration < 0) {
			selfDuration = 0;
		}
	}

	state.currentProfilingData.timings.push(
		id,
		duration,
		selfDuration // without children
	);

	// "Why did this component render?" panel
	let changed = getChangeDescription(vnode);
	if (changed!=null) {
		state.currentProfilingData.changed.set(id, changed);
	}
}

/**
 * Pass all pending operations to the devtools extension
 * @param {import('../internal').DevtoolsHook} hook
 * @param {import('../internal').AdapterState} state
 */
export function flushPendingEvents(hook, state) {
	const { stringTable, isProfiling, currentCommit } = state;
	let { unmountIds, unmountRootId, operations } = currentCommit;
	let numUnmounts = unmountIds.length + (unmountRootId===null ? 0 : 1);

	if (operations.length==0 && numUnmounts > 0 && !isProfiling) {
		return;
	}

	let msg = [
		state.rendererId,
		state.currentRootId,
		...flushTable(stringTable)
	];

	if (numUnmounts > 0) {
		msg.push(
			TREE_OPERATION_REMOVE,
			numUnmounts,
			...unmountIds
		);

		if (unmountRootId!==null) {
			msg.push(unmountRootId);
		}
	}

	msg.push(...operations);

	if (state.connected) {
		hook.emit('operations', msg);
	}
	else {
		state.pendingCommits.push(msg);
	}

	state.currentCommit = {
		operations: [],
		unmountIds: [],
		unmountRootId: null
	};
	stringTable.clear();
}

/**
 * Flush initial buffered events as soon a the devtools successfully established
 * a connection
 * @param {import('../internal').DevtoolsHook} hook
 * @param {import('../internal').AdapterState} state
 * @param {Array<import('../internal').Filter>} filters
 */
export function flushInitialEvents(hook, state, filters) {
	state.connected = true;

	if (state.isProfiling) {
		setupProfileData(state);
	}

	// Flush any events we have queued up so far
	if (state.pendingCommits.length > 0) {
		state.pendingCommits.forEach(commit => {
			hook.emit('operations', commit);
		});
		state.pendingCommits = [];
	}
	else {
		hook.getFiberRoots(state.rendererId).forEach(root => {
			state.currentRootId = getVNodeId(root);
			mount(state, root, 0);
			flushPendingEvents(hook, state);
		});
	}

	if (filters && state.filter.raw!==filters) {
		hook.renderers.get(state.rendererId)
			.updateComponentFilters(state.filter.raw = filters);
	}

	state.currentRootId = -1;
}

/**
 * Find the DOM node for a vnode
 * @param {number} id The id of the vnode
 * @returns {Array<import('../internal').PreactElement | HTMLElement | Text> | null}
 */
export function findDomForVNode(id) {
	let vnode = getVNode(id);
	// TODO: Check for siblings here?
	return vnode!=null ? [vnode._dom].filter(Boolean) : null;
}

/**
 * Provide detailed information about the current vnode
 * @param {number} id vnode id
 * @returns {import('../internal').InspectData}
 */
export function inspectElementRaw(id) {
	let vnode = getVNode(id);
	let hasHooks = vnode._component!=null && vnode._component.__hooks!=null;
	let owners = getOwners(vnode);

	return {
		id,
		canEditHooks: hasHooks,
		canEditFunctionProps: true, // TODO
		canToggleSuspense: false, // TODO
		canViewSource: false, // TODO
		displayName: getDisplayName(vnode),
		type: getVNodeType(vnode),
		context: vnode._component ? cleanContext(vnode._component.context) : null, // TODO
		events: null,
		hooks: hasHooks ? cleanForBridge(inspectHooks(vnode)) : null,
		props: vnode.props!=null && Object.keys(vnode.props).length > 0
			? cleanForBridge(vnode.props)
			: null,
		state: hasHooks || vnode._component==null || !Object.keys(vnode._component.state).length
			? null
			: cleanForBridge(vnode._component.state),
		owners: owners.length ? owners : null,
		source: null // TODO
	};
}

// let lastInspected = -1;

/**
 * Inspect a vnode (the right panel in the devtools)
 * @param {number} id The vnode id to inspect
 * @param {*} path TODO
 * @returns {import('../internal').InspectPayload}
 */
export function inspectElement(id, path) {
	// Prevent infinite loop :/
	// TODO: Somehow this breaks the profiler
	// if (id==lastInspected) return;
	// lastInspected = id;

	if (getVNode(id)==null) return;
	return {
		id,
		type: 'full-data',
		value: inspectElementRaw(id)
	};
}

/**
 * Print an element to console
 * @param {number} id vnode id
 */
export function logElementToConsole(id) {
	let vnode = getVNode(id);
	if (vnode==null) {
		console.warn(`Could not find vnode with id ${id}`);
		return;
	}

	/* eslint-disable no-console */
	console.group(
		`LOG %c<${getDisplayName(vnode) || 'Component'} />`,
		// CSS Variable is injected by the devtools extension
		'color: var(--dom-tag-name-color); font-weight: normal'
	);
	console.log('props:', vnode.props);
	if (vnode._component) {
		console.log('state:', vnode._component.state);
	}
	console.log('vnode:', vnode);
	console.log('devtools id:', getVNodeId(vnode));
	console.groupEnd();
	/* eslint-enable no-console */
}
