import {QueryRunner} from "../query-runner/QueryRunner";
import {Subject} from "./Subject";
import {PromiseUtils} from "../util/PromiseUtils";
import {SubjectTopoligicalSorter} from "./SubjectTopoligicalSorter";
import {SubjectChangedColumnsComputer} from "./SubjectChangedColumnsComputer";
import {SubjectWithoutIdentifierError} from "../error/SubjectWithoutIdentifierError";
import {SubjectRemovedAndUpdatedError} from "../error/SubjectRemovedAndUpdatedError";
import {MongoQueryRunner} from "../driver/mongodb/MongoQueryRunner";
import {MongoEntityManager} from "../entity-manager/MongoEntityManager";
import {InsertResult} from "../query-builder/result/InsertResult";
import {MongoDriver} from "../driver/mongodb/MongoDriver";
import {ObjectLiteral} from "../common/ObjectLiteral";
import {SaveOptions} from "../repository/SaveOptions";
import {RemoveOptions} from "../repository/RemoveOptions";
import {BroadcasterResult} from "../subscriber/BroadcasterResult";

/**
 * Executes all database operations (inserts, updated, deletes) that must be executed
 * with given persistence subjects.
 */
export class SubjectExecutor {

    // -------------------------------------------------------------------------
    // Public Properties
    // -------------------------------------------------------------------------

    /**
     * Indicates if executor has any operations to execute (e.g. has insert / update / delete operations to be executed).
     */
    hasExecutableOperations: boolean = false;

    // -------------------------------------------------------------------------
    // Protected Properties
    // -------------------------------------------------------------------------

    /**
     * QueryRunner used to execute all queries with a given subjects.
     */
    protected queryRunner: QueryRunner;

    /**
     * Persistence options.
     */
    protected options?: SaveOptions & RemoveOptions;

    /**
     * All subjects that needs to be operated.
     */
    protected allSubjects: Subject[];

    /**
     * Subjects that must be inserted.
     */
    protected insertSubjects: Subject[] = [];

    /**
     * Subjects that must be updated.
     */
    protected updateSubjects: Subject[] = [];

    /**
     * Subjects that must be removed.
     */
    protected removeSubjects: Subject[] = [];

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(queryRunner: QueryRunner, subjects: Subject[], options?: SaveOptions & RemoveOptions) {
        this.queryRunner = queryRunner;
        this.allSubjects = subjects;
        this.options = options;
        this.validate();
        this.recompute();
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Executes all operations over given array of subjects.
     * Executes queries using given query runner.
     */
    async execute(): Promise<void> {
        // console.time("SubjectExecutor.execute");

        // broadcast "before" events before we start insert / update / remove operations
        let broadcasterResult: BroadcasterResult|undefined = undefined;
        if (!this.options || this.options.listeners !== false) {
            // console.time(".broadcastBeforeEventsForAll");
            broadcasterResult = this.broadcastBeforeEventsForAll();
            if (broadcasterResult.promises.length > 0) await Promise.all(broadcasterResult.promises);
            // console.timeEnd(".broadcastBeforeEventsForAll");
        }

        // since event listeners and subscribers can call save methods and/or trigger entity changes we need to recompute operational subjects
        // recompute only in the case if any listener or subscriber was really executed
        if (broadcasterResult && broadcasterResult.count > 0) {
            // console.time(".recompute");
            this.recompute();
            // console.timeEnd(".recompute");
        }

        // make sure our insert subjects are sorted (using topological sorting) to make cascade inserts work properly

        // console.timeEnd("prepare");

        // execute all insert operations
        // console.time(".insertion");
        this.insertSubjects = new SubjectTopoligicalSorter(this.insertSubjects).sort("insert");
        await this.executeInsertOperations();
        // console.timeEnd(".insertion");

        // recompute update operations since insertion can create updation operations for the
        // properties it wasn't able to handle on its own (referenced columns)
        this.updateSubjects = this.allSubjects.filter(subject => subject.mustBeUpdated);

        // execute update operations
        // console.time(".updation");
        await this.executeUpdateOperations();
        // console.timeEnd(".updation");

        // make sure our remove subjects are sorted (using topological sorting) when multiple entities are passed for the removal
        // console.time(".removal");
        this.removeSubjects = new SubjectTopoligicalSorter(this.removeSubjects).sort("delete");
        await this.executeRemoveOperations();
        // console.timeEnd(".removal");

        // update all special columns in persisted entities, like inserted id or remove ids from the removed entities
        // console.time(".updateSpecialColumnsInPersistedEntities");
        await this.updateSpecialColumnsInPersistedEntities();
        // console.timeEnd(".updateSpecialColumnsInPersistedEntities");

        // finally broadcast "after" events after we finish insert / update / remove operations
        if (!this.options || this.options.listeners !== false) {
            // console.time(".broadcastAfterEventsForAll");
            broadcasterResult = this.broadcastAfterEventsForAll();
            if (broadcasterResult.promises.length > 0) await Promise.all(broadcasterResult.promises);
            // console.timeEnd(".broadcastAfterEventsForAll");
        }
        // console.timeEnd("SubjectExecutor.execute");
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Validates all given subjects.
     */
    protected validate() {
        this.allSubjects.forEach(subject => {
            if (subject.mustBeUpdated && subject.mustBeRemoved)
                throw new SubjectRemovedAndUpdatedError(subject);
        });
    }

    /**
     * Performs entity re-computations - finds changed columns, re-builds insert/update/remove subjects.
     */
    protected recompute(): void {
        new SubjectChangedColumnsComputer().compute(this.allSubjects);
        this.insertSubjects = this.allSubjects.filter(subject => subject.mustBeInserted);
        this.updateSubjects = this.allSubjects.filter(subject => subject.mustBeUpdated);
        this.removeSubjects = this.allSubjects.filter(subject => subject.mustBeRemoved);
        this.hasExecutableOperations = this.insertSubjects.length > 0 || this.updateSubjects.length > 0 || this.removeSubjects.length > 0;
    }

    /**
     * Broadcasts "BEFORE_INSERT", "BEFORE_UPDATE", "BEFORE_REMOVE" events for all given subjects.
     */
    protected broadcastBeforeEventsForAll(): BroadcasterResult {
        const result = new BroadcasterResult();
        if (this.insertSubjects.length)
            this.insertSubjects.forEach(subject => this.queryRunner.broadcaster.broadcastBeforeInsertEvent(result, subject.metadata, subject.entity!));
        if (this.updateSubjects.length)
            this.updateSubjects.forEach(subject => this.queryRunner.broadcaster.broadcastBeforeUpdateEvent(result, subject.metadata, subject.entity!, subject.databaseEntity));
        if (this.removeSubjects.length)
            this.removeSubjects.forEach(subject => this.queryRunner.broadcaster.broadcastBeforeRemoveEvent(result, subject.metadata, subject.entity!, subject.databaseEntity));
        return result;
    }

    /**
     * Broadcasts "AFTER_INSERT", "AFTER_UPDATE", "AFTER_REMOVE" events for all given subjects.
     * Returns void if there wasn't any listener or subscriber executed.
     * Note: this method has a performance-optimized code organization.
     */
    protected broadcastAfterEventsForAll(): BroadcasterResult {
        const result = new BroadcasterResult();
        if (this.insertSubjects.length)
            this.insertSubjects.forEach(subject => this.queryRunner.broadcaster.broadcastAfterInsertEvent(result, subject.metadata, subject.entity!));
        if (this.updateSubjects.length)
            this.updateSubjects.forEach(subject => this.queryRunner.broadcaster.broadcastAfterUpdateEvent(result, subject.metadata, subject.entity!, subject.databaseEntity));
        if (this.removeSubjects.length)
            this.removeSubjects.forEach(subject => this.queryRunner.broadcaster.broadcastAfterRemoveEvent(result, subject.metadata, subject.entity!, subject.databaseEntity));
        return result;
    }

    /**
     * Executes insert operations.
     */
    protected async executeInsertOperations(): Promise<void> {

        // group insertion subjects to make bulk insertions
        const [groupedInsertSubjects, groupedInsertSubjectKeys] = this.groupBulkSubjects(this.insertSubjects, "insert");

        // then we run insertion in the sequential order which is important since we have an ordered subjects
        await PromiseUtils.runInSequence(groupedInsertSubjectKeys, async groupName => {
            const subjects = groupedInsertSubjects[groupName];
            const insertMaps = subjects.map(subject => {
                if (this.queryRunner.connection.driver instanceof MongoDriver) {
                    return subject.entity;
                } else {
                    return subject.createValueSetAndPopChangeMap();
                }
            });
            let insertResult: InsertResult;

            // for mongodb we have a bit different insertion logic
            if (this.queryRunner instanceof MongoQueryRunner) {

                const manager = this.queryRunner.manager as MongoEntityManager;
                insertResult = await manager.insert(subjects[0].metadata.target, insertMaps);

            } else {

                // here we execute our insertion query
                // we need to enable entity updation because we DO need to have updated insertedMap
                // which is not same object as our entity that's why we don't need to worry about our entity to get dirty
                // also, we disable listeners because we call them on our own in persistence layer
                insertResult = await this.queryRunner
                    .manager
                    .createQueryBuilder()
                    .insert()
                    .into(subjects[0].metadata.target)
                    .values(insertMaps)
                    .updateEntity(this.options && this.options.reload === false ? false : true)
                    .callListeners(false)
                    .execute();
            }

            subjects.forEach((subject, index) => {
                subject.identifier = insertResult.identifiers[index];
                subject.generatedMap = insertResult.generatedMaps[index];
                subject.insertedValueSet = insertMaps[index];
            });
        });
    }

    /**
     * Updates all given subjects in the database.
     */
    protected async executeUpdateOperations(): Promise<void> {
        await Promise.all(this.updateSubjects.map(async subject => {

            if (!subject.identifier)
                throw new SubjectWithoutIdentifierError(subject);

            const updateMap: ObjectLiteral = this.queryRunner.connection.driver instanceof MongoDriver ? subject.entity! : subject.createValueSetAndPopChangeMap();

            // for mongodb we have a bit different updation logic
            if (this.queryRunner instanceof MongoQueryRunner) {
                const manager = this.queryRunner.manager as MongoEntityManager;
                await manager.update(subject.metadata.target, subject.identifier, updateMap);

            } else {

                // here we execute our updation query
                // we need to enable entity updation because we update a subject identifier
                // which is not same object as our entity that's why we don't need to worry about our entity to get dirty
                // also, we disable listeners because we call them on our own in persistence layer
                const updateQueryBuilder = this.queryRunner
                    .manager
                    .createQueryBuilder()
                    .update(subject.metadata.target)
                    .set(updateMap)
                    .updateEntity(this.options && this.options.reload === false ? false : true)
                    .callListeners(false);

                if (subject.entity) {
                    updateQueryBuilder.whereEntity(subject.identifier);

                } else { // in this case identifier is just conditions object to update by
                    updateQueryBuilder.where(subject.identifier);
                }

                const updateResult = await updateQueryBuilder.execute();
                subject.generatedMap = updateResult.generatedMaps[0];
            }
        }));
    }

    /**
     * Removes all given subjects from the database.
     *
     * todo: we need to apply topological sort here as well
     */
    protected async executeRemoveOperations(): Promise<void> {
        // group insertion subjects to make bulk insertions
        const [groupedRemoveSubjects, groupedRemoveSubjectKeys] = this.groupBulkSubjects(this.removeSubjects, "delete");

        await PromiseUtils.runInSequence(groupedRemoveSubjectKeys, async groupName => {
            const subjects = groupedRemoveSubjects[groupName];
            const deleteMaps = subjects.map(subject => {
                if (!subject.identifier)
                    throw new SubjectWithoutIdentifierError(subject);

                return subject.identifier;
            });

            // for mongodb we have a bit different updation logic
            if (this.queryRunner instanceof MongoQueryRunner) {
                const manager = this.queryRunner.manager as MongoEntityManager;
                await manager.delete(subjects[0].metadata.target, deleteMaps);

            } else {

                // here we execute our deletion query
                // we don't need to specify entities and set update entity to true since the only thing query builder
                // will do for use is a primary keys deletion which is handled by us later once persistence is finished
                // also, we disable listeners because we call them on our own in persistence layer
                await this.queryRunner
                    .manager
                    .createQueryBuilder()
                    .delete()
                    .from(subjects[0].metadata.target)
                    .where(deleteMaps)
                    .callListeners(false)
                    .execute();
            }
        });
    }

    /**
     * Updates all special columns of the saving entities (create date, update date, version, etc.).
     * Also updates nullable columns and columns with default values.
     */
    protected updateSpecialColumnsInPersistedEntities(): void {

        // update inserted entity properties
        if (this.insertSubjects.length)
            this.updateSpecialColumnsInInsertedAndUpdatedEntities(this.insertSubjects);

        // update updated entity properties
        if (this.updateSubjects.length)
            this.updateSpecialColumnsInInsertedAndUpdatedEntities(this.updateSubjects);

        // remove ids from the entities that were removed
        if (this.removeSubjects.length) {
            this.removeSubjects.forEach(subject => {
                if (!subject.entity) return;

                subject.metadata.primaryColumns.forEach(primaryColumn => {
                    primaryColumn.setEntityValue(subject.entity!, undefined);
                });
            });
        }

        // other post-persist updations
        this.allSubjects.forEach(subject => {
            if (!subject.entity) return;

            subject.metadata.relationIds.forEach(relationId => {
                relationId.setValue(subject.entity!);
            });
        });
    }

    /**
     * Updates all special columns of the saving entities (create date, update date, version, etc.).
     * Also updates nullable columns and columns with default values.
     */
    protected updateSpecialColumnsInInsertedAndUpdatedEntities(subjects: Subject[]): void {
        subjects.forEach(subject => {
            if (!subject.entity) return;

            // set values to "null" for nullable columns that did not have values
            subject.metadata.columns.forEach(column => {
                if (!column.isNullable || column.isVirtual)
                    return;

                const columnValue = column.getEntityValue(subject.entity!);
                if (columnValue === undefined)
                    column.setEntityValue(subject.entity!, null);
            });

            // merge into entity all generated values returned by a database
            if (subject.generatedMap)
                this.queryRunner.manager.merge(subject.metadata.target, subject.entity, subject.generatedMap);
        });
    }

    /**
     * Groups subjects by metadata names (by tables) to make bulk insertions and deletions possible.
     * However there are some limitations with bulk insertions of data into tables with generated (increment) columns
     * in some drivers. Some drivers like mysql and sqlite does not support returning multiple generated columns
     * after insertion and can only return a single generated column value, that's why its not possible to do bulk insertion,
     * because it breaks insertion result's generatedMap and leads to problems when this subject is used in other subjects saves.
     * That's why we only support bulking in junction tables for those drivers.
     *
     * Other drivers like postgres and sql server support RETURNING / OUTPUT statement which allows to return generated
     * id for each inserted row, that's why bulk insertion is not limited to junction tables in there.
     */
    protected groupBulkSubjects(subjects: Subject[], type: "insert"|"delete"): [{ [key: string]: Subject[] }, string[]] {
        const group: { [key: string]: Subject[] } = {};
        const keys: string[] = [];
        const groupingAllowed = type === "delete" || this.queryRunner.connection.driver.isReturningSqlSupported();

        subjects.forEach((subject, index) => {
            const key = groupingAllowed || subject.metadata.isJunction ? subject.metadata.name : subject.metadata.name + "_" + index;
            if (!group[key]) {
                group[key] = [subject];
                keys.push(key);
            } else {
                group[key].push(subject);
            }
        });

        return [group, keys];
    }

}