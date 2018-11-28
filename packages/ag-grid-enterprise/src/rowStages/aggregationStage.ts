import {
    Bean,
    IRowNodeStage,
    Autowired,
    GridOptionsWrapper,
    ColumnController,
    ValueService,
    RowNode,
    Column,
    Utils,
    StageExecuteParams,
    IAggFunc,
    ChangedPath,
    _
} from "ag-grid-community";
import {PivotStage} from "./pivotStage";
import {AggFuncService} from "../aggregation/aggFuncService";

interface AggregationDetails {
    changedPath: ChangedPath;
    valueColumns: Column[];
    pivotColumns: Column[];
}

@Bean('aggregationStage')
export class AggregationStage implements IRowNodeStage {

    @Autowired('gridOptionsWrapper') private gridOptionsWrapper: GridOptionsWrapper;
    @Autowired('columnController') private columnController: ColumnController;
    @Autowired('valueService') private valueService: ValueService;
    @Autowired('pivotStage') private pivotStage: PivotStage;
    @Autowired('aggFuncService') private aggFuncService: AggFuncService;

    // it's possible to recompute the aggregate without doing the other parts
    // + gridApi.recomputeAggregates()
    public execute(params: StageExecuteParams): any {

        // we don't do aggregation if doing legacy tree good
        const doingLegacyTreeData = _.exists(this.gridOptionsWrapper.getNodeChildDetailsFunc());
        if (doingLegacyTreeData) { return null; }

        const aggDetails = this.createAggDetails(params);

        this.recursivelyCreateAggData(params.rowNode, aggDetails);
    }

    private createAggDetails(params: StageExecuteParams): AggregationDetails {

        const pivotActive = this.columnController.isPivotActive();

        const measureColumns = this.columnController.getValueColumns();
        const pivotColumns = pivotActive ? this.columnController.getPivotColumns() : [];

        const aggDetails = <AggregationDetails> {
            changedPath: params.changedPath,
            valueColumns: measureColumns,
            pivotColumns: pivotColumns
        };

        return aggDetails;
    }

    private recursivelyCreateAggData(rowNode: RowNode, aggDetails: AggregationDetails) {

        // aggregate all children first, as we use the result in this nodes calculations
        rowNode.childrenAfterFilter.forEach( (child: RowNode) => {
            const nodeHasChildren = child.hasChildren();
            if (nodeHasChildren) {
                this.recursivelyCreateAggData(child, aggDetails);
            } else {
                if (child.aggData) {
                    child.setAggData(null);
                }
            }
        });

        //Optionally prevent the aggregation at the root Node
        //https://ag-grid.atlassian.net/browse/AG-388
        const isRootNode = rowNode.level === -1;
        if (isRootNode) {
            const notPivoting = !this.columnController.isPivotMode();
            const suppressAggAtRootLevel = this.gridOptionsWrapper.isSuppressAggAtRootLevel();
            if (suppressAggAtRootLevel && notPivoting) { return; }
        }

        const skipBecauseNoChangedPath = aggDetails.changedPath.isActive()
            && !aggDetails.changedPath.isInPath(rowNode);

        if (skipBecauseNoChangedPath) { return; }

        this.aggregateRowNode(rowNode, aggDetails);
    }

    private aggregateRowNode(rowNode: RowNode, aggDetails: AggregationDetails): void {

        const measureColumnsMissing = aggDetails.valueColumns.length === 0;
        const pivotColumnsMissing = aggDetails.pivotColumns.length === 0;
        const userFunc = this.gridOptionsWrapper.getGroupRowAggNodesFunc();

        let aggResult: any;
        if (userFunc) {
            aggResult = userFunc(rowNode.childrenAfterFilter);
        } else if (measureColumnsMissing) {
            aggResult = null;
        } else if (pivotColumnsMissing) {
            aggResult = this.aggregateRowNodeUsingValuesOnly(rowNode, aggDetails);
        } else {
            aggResult = this.aggregateRowNodeUsingValuesAndPivot(rowNode);
        }

        rowNode.setAggData(aggResult);

        // if we are grouping, then it's possible there is a sibling footer
        // to the group, so update the data here also if there is one
        if (rowNode.sibling) {
            rowNode.sibling.setAggData(aggResult);
        }
    }

    private aggregateRowNodeUsingValuesAndPivot(rowNode: RowNode): any {
        const result: any = {};
        const pivotColumnDefs = this.pivotStage.getPivotColumnDefs();

        // Step 1: process value columns
        pivotColumnDefs
            .filter(v => !Utils.exists(v.pivotTotalColumnIds)) // only process pivot value columns
            .forEach(valueColDef => {
                const keys: string[] = valueColDef.pivotKeys || [];
                let values: any[];
                const valueColumn: Column = valueColDef.pivotValueColumn as Column;
                const colId = valueColDef.colId as string;

                if (rowNode.leafGroup) {
                    // lowest level group, get the values from the mapped set
                    values = this.getValuesFromMappedSet(rowNode.childrenMapped, keys, valueColumn);
                } else {
                    // value columns and pivot columns, non-leaf group
                    values = this.getValuesPivotNonLeaf(rowNode, colId);
                }

                result[colId] = this.aggregateValues(values, valueColumn.getAggFunc());
            });

        // Step 2: process total columns
        pivotColumnDefs
            .filter(v => Utils.exists(v.pivotTotalColumnIds)) // only process pivot total columns
            .forEach(totalColDef => {
                const aggResults: any[] = [];
                const {pivotValueColumn, pivotTotalColumnIds, colId} = totalColDef;

                //retrieve results for colIds associated with this pivot total column
                if (!pivotTotalColumnIds || !pivotTotalColumnIds.length) {
                    return;
                }

                pivotTotalColumnIds.forEach((colId: string) => {
                    aggResults.push(result[colId]);
                });

                result[colId as string] = this.aggregateValues(aggResults, (pivotValueColumn as Column).getAggFunc());
            });

        return result;
    }

    private aggregateRowNodeUsingValuesOnly(rowNode: RowNode, aggDetails: AggregationDetails): any {
        const result: any = {};

        const changedValueColumns = aggDetails.changedPath.isActive() ?
            aggDetails.changedPath.getValueColumnsForNode(rowNode, aggDetails.valueColumns)
            : aggDetails.valueColumns;

        const notChangedValueColumns = aggDetails.changedPath.isActive() ?
            aggDetails.changedPath.getNotValueColumnsForNode(rowNode, aggDetails.valueColumns)
            : null;

        const values2d = this.getValuesNormal(rowNode, changedValueColumns);
        const oldValues = rowNode.aggData;

        changedValueColumns.forEach( (valueColumn: Column, index: number) => {
            result[valueColumn.getId()] = this.aggregateValues(values2d[index], valueColumn.getAggFunc());
        });

        if (notChangedValueColumns && oldValues) {
            notChangedValueColumns.forEach( (valueColumn: Column) => {
                result[valueColumn.getId()] = oldValues[valueColumn.getId()];
            });
        }

        return result;
    }

    private getValuesPivotNonLeaf(rowNode: RowNode, colId: string): any[] {
        const values: any[] = [];
        rowNode.childrenAfterFilter.forEach( (node: RowNode) => {
            const value = node.aggData[colId];
            values.push(value);
        });
        return values;
    }

    private getValuesFromMappedSet(mappedSet: any, keys: string[], valueColumn: Column): any[] {
        let mapPointer = mappedSet;
        keys.forEach(key => (mapPointer = mapPointer ? mapPointer[key] : null));

        if (!mapPointer) {
            return [];
        }

        const values: any = [];
        mapPointer.forEach( (rowNode: RowNode) => {
            const value = this.valueService.getValue(valueColumn, rowNode);
            values.push(value);
        });

        return values;
    }

    private getValuesNormal(rowNode: RowNode, valueColumns: Column[]): any[][] {
        // create 2d array, of all values for all valueColumns
        const values: any[][] = [];
        valueColumns.forEach( ()=> values.push([]) );

        const valueColumnCount = valueColumns.length;
        const rowCount = rowNode.childrenAfterFilter.length;

        for (let i = 0; i < rowCount; i++) {
            const childNode = rowNode.childrenAfterFilter[i];
            for (let j = 0; j < valueColumnCount; j++) {
                const valueColumn = valueColumns[j];
                // if the row is a group, then it will only have an agg result value,
                // which means valueGetter is never used.
                const value = this.valueService.getValue(valueColumn, childNode);
                values[j].push(value);
            }
        }

        return values;
    }

    private aggregateValues(values: any[], aggFuncOrString: string | IAggFunc): any {
        let aggFunction: IAggFunc;

        if (typeof aggFuncOrString === 'string') {
            aggFunction = this.aggFuncService.getAggFunc(<string>aggFuncOrString);
        } else {
            aggFunction = <IAggFunc> aggFuncOrString;
        }

        if (typeof aggFunction !== 'function') {
            console.error(`ag-Grid: unrecognised aggregation function ${aggFuncOrString}`);
            return null;
        }

        return aggFunction(values);
    }
}
